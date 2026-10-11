//go:build windows

package main

import (
	"errors"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// job is a Windows job object that holds node.exe and, through inheritance, everything it starts (the engine, the
// ffmpeg encoders and cover jobs). Closing the launcher closes the job, and Windows then ends every process in it, so
// nothing is left behind even if the launcher crashes. The job allows no breakaway, so children can't leave it.
type job struct {
	h windows.Handle

	mu    sync.Mutex
	freed map[uint32]bool // pids already opted out of power throttling
}

func newJob() (*job, error) {
	h, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	// kill on close; a crashing child just ends (no Windows Error Reporting dialog waiting for a click nobody gives)
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
	if _, err := windows.SetInformationJobObject(h, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(h)
		return nil, err
	}
	return &job{h: h, freed: map[uint32]bool{}}, nil
}

// adopt puts a (still suspended) process into the job and turns power throttling off for it.
func (j *job) adopt(pid uint32) error {
	ph, err := windows.OpenProcess(processAdoptRights, false, pid)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(ph)
	err = windows.AssignProcessToJobObject(j.h, ph)
	noThrottle(ph)
	j.mu.Lock()
	j.freed[pid] = true
	j.mu.Unlock()
	return err
}

// pids lists the processes in the job.
func (j *job) pids() []uint32 {
	var list struct {
		Assigned, InList uint32
		IDs              [128]uintptr
	}
	err := windows.QueryInformationJobObject(j.h, windows.JobObjectBasicProcessIdList, uintptr(unsafe.Pointer(&list)), uint32(unsafe.Sizeof(list)), nil)
	if err != nil && !errors.Is(err, windows.ERROR_MORE_DATA) {
		return nil
	}
	n := int(list.InList)
	if n > len(list.IDs) {
		n = len(list.IDs)
	}
	out := make([]uint32, 0, n)
	for _, id := range list.IDs[:n] {
		out = append(out, uint32(id))
	}
	return out
}

// unthrottleNew turns power throttling off for processes that joined since the last call (the engine and ffmpeg,
// which node.exe starts). Returns how many it changed.
func (j *job) unthrottleNew() int {
	now := j.pids()
	j.mu.Lock()
	defer j.mu.Unlock()
	alive := map[uint32]bool{}
	n := 0
	for _, pid := range now {
		alive[pid] = true
		if j.freed[pid] {
			continue
		}
		j.freed[pid] = true
		if ph, err := windows.OpenProcess(processSetInformationAndQuery, false, pid); err == nil {
			if noThrottle(ph) == nil {
				n++
			}
			windows.CloseHandle(ph)
		}
	}
	for pid := range j.freed { // forget processes that ended (pids get reused)
		if !alive[pid] {
			delete(j.freed, pid)
		}
	}
	return n
}

// killAll ends every process in the job (stragglers after node.exe stopped, or a bridge that ignores quit). The job
// stays usable for the next start.
func (j *job) killAll() {
	windows.TerminateJobObject(j.h, 1)
}

// resumeProcess resumes the threads of a process started with CREATE_SUSPENDED. (os/exec keeps the thread handle to
// itself, so the threads are found through a Toolhelp snapshot.)
func resumeProcess(pid uint32) error {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snap)
	var te windows.ThreadEntry32
	te.Size = uint32(unsafe.Sizeof(te))
	resumed := 0
	for err = windows.Thread32First(snap, &te); err == nil; err = windows.Thread32Next(snap, &te) {
		if te.OwnerProcessID != pid {
			continue
		}
		th, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, te.ThreadID)
		if err != nil {
			continue
		}
		if _, err := windows.ResumeThread(th); err == nil {
			resumed++
		}
		windows.CloseHandle(th)
	}
	if resumed == 0 {
		return errors.New("couldn't resume node.exe")
	}
	return nil
}
