//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	kernel32                    = windows.NewLazySystemDLL("kernel32.dll")
	shell32                     = windows.NewLazySystemDLL("shell32.dll")
	procSetThreadExecutionState = kernel32.NewProc("SetThreadExecutionState")
	procSetProcessInformation   = kernel32.NewProc("SetProcessInformation")
	procShellExecuteExW         = shell32.NewProc("ShellExecuteExW")
)

// ---- dialogs

const (
	mbInfo     = windows.MB_OK | windows.MB_ICONINFORMATION
	mbWarn     = windows.MB_OK | windows.MB_ICONWARNING
	mbError    = windows.MB_OK | windows.MB_ICONERROR
	mbQuestion = windows.MB_YESNO | windows.MB_ICONQUESTION
	idYes      = 6
)

// msgBox shows a message box in front of other windows. It may be called from any goroutine. (The update test build
// answers it itself, testhooks_updatetest.go; a release build always shows it.)
func msgBox(text string, flags uint32) int32 {
	if r, ok := testDialog(text, flags); ok {
		return r
	}
	t, _ := windows.UTF16PtrFromString(strings.ReplaceAll(text, "\x00", ""))
	c, _ := windows.UTF16PtrFromString("Encore Bridge")
	r, _ := windows.MessageBox(0, t, c, flags|windows.MB_SETFOREGROUND|windows.MB_TOPMOST)
	return r
}

func ask(text string) bool { return msgBox(text, mbQuestion) == idYes }

// ---- opening things

func shellOpen(file, args string) error {
	verb, _ := windows.UTF16PtrFromString("open")
	f, err := windows.UTF16PtrFromString(file)
	if err != nil {
		return err
	}
	var a *uint16
	if args != "" {
		a, _ = windows.UTF16PtrFromString(args)
	}
	return windows.ShellExecute(0, verb, f, a, nil, windows.SW_SHOWNORMAL)
}

// openURL opens an http(s) address in the default browser.
func openURL(u string) error {
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		return errors.New("not a web address")
	}
	return shellOpen(u, "")
}

// openInNotepad opens a text file (settings.env has no file association, and a log should never open in anything
// that runs it).
func openInNotepad(path string) error {
	np := filepath.Join(os.Getenv("SystemRoot"), "System32", "notepad.exe")
	if _, err := os.Stat(np); err != nil {
		np = "notepad.exe"
	}
	return shellOpen(np, `"`+path+`"`)
}

func openFolder(path string) error { return shellOpen(path, "") }

// ---- keep awake

const (
	esContinuous     = 0x80000000
	esSystemRequired = 0x00000001
)

// keepAwake holds "this PC must not sleep" while on. SetThreadExecutionState belongs to the calling thread, so one
// locked OS thread owns it for the launcher's whole life.
type keepAwake struct{ ch chan bool }

func newKeepAwake() *keepAwake {
	k := &keepAwake{ch: make(chan bool, 1)}
	go k.loop()
	return k
}

func (k *keepAwake) loop() {
	runtime.LockOSThread()
	on := false
	for want := range k.ch {
		if want == on {
			continue
		}
		flags := uintptr(esContinuous)
		if want {
			flags |= esSystemRequired
		}
		if r, _, _ := procSetThreadExecutionState.Call(flags); r != 0 {
			on = want
		}
	}
}

// Set asks for the state; only the newest request counts.
func (k *keepAwake) Set(v bool) {
	for {
		select {
		case k.ch <- v:
			return
		default:
			select {
			case <-k.ch:
			default:
			}
		}
	}
}

// ---- power throttling

const (
	processPowerThrottling               = 4 // PROCESS_INFORMATION_CLASS
	powerThrottlingExecutionSpeed        = 0x1
	powerThrottlingIgnoreTimerResolution = 0x4
	processPowerThrottlingCurrentVersion = 1
	processSetInformationAndQuery        = windows.PROCESS_SET_INFORMATION | windows.PROCESS_QUERY_LIMITED_INFORMATION
	processAdoptRights                   = windows.PROCESS_SET_QUOTA | windows.PROCESS_TERMINATE | processSetInformationAndQuery
)

type powerThrottlingState struct{ Version, ControlMask, StateMask uint32 }

// noThrottle opts a process out of Windows 11's EcoQoS / efficiency-core throttling, which otherwise slows windowless
// background processes and makes audio stutter. ControlMask set with StateMask clear means "never throttle". Older
// Windows versions lack the call or the timer flag; both are fine to ignore.
func noThrottle(h windows.Handle) error {
	if procSetProcessInformation.Find() != nil {
		return nil
	}
	s := powerThrottlingState{Version: processPowerThrottlingCurrentVersion, ControlMask: powerThrottlingExecutionSpeed | powerThrottlingIgnoreTimerResolution}
	r, _, err := procSetProcessInformation.Call(uintptr(h), processPowerThrottling, uintptr(unsafe.Pointer(&s)), unsafe.Sizeof(s))
	if r != 0 {
		return nil
	}
	s.ControlMask = powerThrottlingExecutionSpeed
	if r, _, err = procSetProcessInformation.Call(uintptr(h), processPowerThrottling, uintptr(unsafe.Pointer(&s)), unsafe.Sizeof(s)); r != 0 {
		return nil
	}
	return err
}

// ---- elevation

// shellExecuteInfo is SHELLEXECUTEINFOW (112 bytes on amd64; Go adds the same padding as the C compiler).
type shellExecuteInfo struct {
	cbSize       uint32
	fMask        uint32
	hwnd         windows.Handle
	lpVerb       *uint16
	lpFile       *uint16
	lpParameters *uint16
	lpDirectory  *uint16
	nShow        int32
	hInstApp     windows.Handle
	lpIDList     uintptr
	lpClass      *uint16
	hkeyClass    windows.Handle
	dwHotKey     uint32
	hIcon        windows.Handle
	hProcess     windows.Handle
}

const (
	seeMaskNoCloseProcess = 0x00000040
	seeMaskNoAsync        = 0x00000100
	seeMaskFlagNoUI       = 0x00000400
)

var errCancelled = errors.New("cancelled")

// runElevated starts file with params through the UAC prompt ("runas"), hidden, and waits for it. It returns
// errCancelled when the user says No to the prompt.
func runElevated(file, params string, timeout time.Duration) (uint32, error) {
	verb, _ := windows.UTF16PtrFromString("runas")
	f, err := windows.UTF16PtrFromString(file)
	if err != nil {
		return 0, err
	}
	p, err := windows.UTF16PtrFromString(params)
	if err != nil {
		return 0, err
	}
	info := shellExecuteInfo{fMask: seeMaskNoCloseProcess | seeMaskNoAsync, lpVerb: verb, lpFile: f, lpParameters: p, nShow: windows.SW_HIDE}
	info.cbSize = uint32(unsafe.Sizeof(info))
	if r, _, err := procShellExecuteExW.Call(uintptr(unsafe.Pointer(&info))); r == 0 {
		if errors.Is(err, windows.ERROR_CANCELLED) {
			return 0, errCancelled
		}
		return 0, err
	}
	if info.hProcess == 0 {
		return 0, errors.New("no process")
	}
	defer windows.CloseHandle(info.hProcess)
	ev, err := windows.WaitForSingleObject(info.hProcess, uint32(timeout/time.Millisecond))
	if err != nil {
		return 0, err
	}
	if ev != windows.WAIT_OBJECT_0 {
		return 0, errors.New("timed out")
	}
	var code uint32
	if err := windows.GetExitCodeProcess(info.hProcess, &code); err != nil {
		return 0, err
	}
	return code, nil
}

// ---- single instance and the installer's signals (CONTRACT.md §8)

const (
	mutexName       = `Local\EncoreBridgeLauncher`
	globalMutexName = `Global\EncoreBridgeLauncher`
	quitEventName   = `Local\EncoreBridgeLauncher.quit`
	showEventName   = `Local\EncoreBridgeLauncher.show`
)

type instance struct{ mutex, global, quitEv, showEv windows.Handle }

// acquireInstance makes this the running launcher of this Windows session, or reports that one already runs.
func acquireInstance() (*instance, bool, error) {
	name, _ := windows.UTF16PtrFromString(mutexName)
	m, err := windows.CreateMutex(nil, false, name)
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		windows.CloseHandle(m)
		return nil, true, nil
	}
	if err != nil {
		return nil, false, err
	}
	in := &instance{mutex: m}
	if g, _ := windows.UTF16PtrFromString(globalMutexName); g != nil {
		in.global, _ = windows.CreateMutex(nil, false, g) // the installer's AppMutex; may already exist in another session
	}
	for _, x := range []struct {
		name string
		h    *windows.Handle
	}{{quitEventName, &in.quitEv}, {showEventName, &in.showEv}} {
		n, _ := windows.UTF16PtrFromString(x.name)
		h, err := windows.CreateEvent(nil, 0, 0, n)
		if err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
			in.close()
			return nil, false, err
		}
		*x.h = h
	}
	return in, false, nil
}

// watch calls onQuit / onShow when another process sets the events.
func (in *instance) watch(onQuit, onShow func()) {
	go func() {
		hs := []windows.Handle{in.quitEv, in.showEv}
		for {
			ev, err := windows.WaitForMultipleObjects(hs, false, windows.INFINITE)
			if err != nil {
				return
			}
			switch ev {
			case windows.WAIT_OBJECT_0:
				go onQuit()
			case windows.WAIT_OBJECT_0 + 1:
				go onShow()
			default:
				return
			}
		}
	}()
}

func (in *instance) close() {
	for _, h := range []windows.Handle{in.quitEv, in.showEv, in.global, in.mutex} {
		if h != 0 {
			windows.CloseHandle(h)
		}
	}
}

// signalEvent sets a running launcher's event; false when no launcher runs in this session.
func signalEvent(name string) bool {
	n, _ := windows.UTF16PtrFromString(name)
	h, err := windows.OpenEvent(windows.EVENT_MODIFY_STATE, false, n)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	return windows.SetEvent(h) == nil
}

// waitInstanceGone waits until the running launcher has exited (its mutex is gone).
func waitInstanceGone(timeout time.Duration) bool {
	n, _ := windows.UTF16PtrFromString(mutexName)
	deadline := time.Now().Add(timeout)
	for {
		h, err := windows.OpenMutex(windows.SYNCHRONIZE, false, n)
		if err != nil {
			return true
		}
		windows.CloseHandle(h)
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// ---- Start with Windows (per-user Run entry, D18)

const (
	runKeyPath      = `Software\Microsoft\Windows\CurrentVersion\Run`
	approvedKeyPath = `Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`
	runValueName    = "Encore Bridge"
)

func autostartCommand(exe string) string { return `"` + exe + `" --autostart` }

// autostartEnabled: the Run entry points at this exe, and it isn't switched off in Task Manager's Startup apps.
func autostartEnabled(exe string) bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	v, _, err := k.GetStringValue(runValueName)
	k.Close()
	if err != nil || !strings.EqualFold(runTarget(v), exe) {
		return false
	}
	if a, err := registry.OpenKey(registry.CURRENT_USER, approvedKeyPath, registry.QUERY_VALUE); err == nil {
		b, _, err := a.GetBinaryValue(runValueName)
		a.Close()
		if err == nil && len(b) > 0 && b[0]&1 == 1 { // 0x03 / 0x07: disabled in Task Manager
			return false
		}
	}
	return true
}

// runTarget extracts the program path from a Run entry command line.
func runTarget(cmd string) string {
	cmd = strings.TrimSpace(cmd)
	if strings.HasPrefix(cmd, `"`) {
		if i := strings.Index(cmd[1:], `"`); i >= 0 {
			return cmd[1 : 1+i]
		}
	}
	if i := strings.Index(strings.ToLower(cmd), ".exe"); i >= 0 {
		return cmd[:i+4]
	}
	return cmd
}

// setAutostart turns the Run entry on (pointing at this exe) or off. Turning it on also clears a "disabled" mark
// left by Task Manager, so the switch means what it says.
func setAutostart(exe string, on bool) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKeyPath, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if !on {
		if err := k.DeleteValue(runValueName); err != nil && !errors.Is(err, registry.ErrNotExist) {
			return err
		}
		return nil
	}
	if err := k.SetStringValue(runValueName, autostartCommand(exe)); err != nil {
		return err
	}
	if a, err := registry.OpenKey(registry.CURRENT_USER, approvedKeyPath, registry.SET_VALUE); err == nil {
		a.DeleteValue(runValueName)
		a.Close()
	}
	return nil
}

// ---- updates (DESIGN-UPDATES.md §5)

// shellStart starts file with params through the shell with the verb "open" (not "runas": Setup carries an asInvoker
// manifest and elevates itself, so Windows' prompt still appears and Setup knows the original user, §5.6), and
// returns its process handle, which the caller closes.
func shellStart(file, params string) (windows.Handle, error) {
	verb, _ := windows.UTF16PtrFromString("open")
	f, err := windows.UTF16PtrFromString(file)
	if err != nil {
		return 0, err
	}
	p, err := windows.UTF16PtrFromString(params)
	if err != nil {
		return 0, err
	}
	info := shellExecuteInfo{fMask: seeMaskNoCloseProcess | seeMaskNoAsync | seeMaskFlagNoUI, lpVerb: verb, lpFile: f, lpParameters: p,
		nShow: windows.SW_SHOWNORMAL}
	info.cbSize = uint32(unsafe.Sizeof(info))
	if r, _, err := procShellExecuteExW.Call(uintptr(unsafe.Pointer(&info))); r == 0 {
		return 0, err
	}
	if info.hProcess == 0 {
		return 0, errors.New("no process")
	}
	return info.hProcess, nil
}

// waitProcess waits for a process to end and returns its exit code.
func waitProcess(h windows.Handle) (uint32, error) {
	if _, err := windows.WaitForSingleObject(h, windows.INFINITE); err != nil {
		return 0, err
	}
	var code uint32
	err := windows.GetExitCodeProcess(h, &code)
	return code, err
}

// openLocked opens a file for reading with read sharing only: while the handle is open no other process can write to
// it, rename it or delete it (§5.5). Starting the file as a program still works (that only reads it).
func openLocked(path string) (*os.File, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(h), path), nil
}

// finalPath is the path an open file really has, with every junction and link on the way resolved (§5.5). Setup is
// started by this path, so a folder junction changed after the hash check can't send Windows to another file: the
// locked file can't be replaced, and its real folders can't be renamed while it is open.
func finalPath(f *os.File) (string, error) {
	buf := make([]uint16, windows.MAX_LONG_PATH)
	const fileNameNormalized, volumeNameDOS = 0x0, 0x0 // GetFinalPathNameByHandleW flags (not in x/sys/windows)
	n, err := windows.GetFinalPathNameByHandle(windows.Handle(f.Fd()), &buf[0], uint32(len(buf)),
		fileNameNormalized|volumeNameDOS)
	if err != nil {
		return "", err
	}
	if n == 0 || int(n) >= len(buf) {
		return "", errors.New("no final path")
	}
	p := windows.UTF16ToString(buf[:n])
	switch {
	case strings.HasPrefix(p, `\\?\UNC\`):
		p = `\\` + p[len(`\\?\UNC\`):]
	case strings.HasPrefix(p, `\\?\`):
		p = p[len(`\\?\`):]
	}
	return p, nil
}

// noReparse makes sure path isn't a junction or another reparse point (§5.5): one found there (never made by Encore
// Bridge) is removed, which removes only the link, never the folder it points to. A missing path is fine.
func noReparse(path string) (removed bool, err error) {
	fi, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	d, ok := fi.Sys().(*syscall.Win32FileAttributeData)
	if !ok || d.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT == 0 {
		return false, nil
	}
	if err := os.Remove(path); err != nil {
		return false, err
	}
	return true, nil
}

// freeSpace is the space this user may still use on the volume that holds dir.
func freeSpace(dir string) (uint64, error) {
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return 0, err
	}
	var avail, total, free uint64
	if err := windows.GetDiskFreeSpaceEx(p, &avail, &total, &free); err != nil {
		return 0, err
	}
	return avail, nil
}

// uninstallKey is the installer's entry (AppId {6E0C2B7A-…}, EncoreBridge.iss).
const uninstallKey = `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{6E0C2B7A-3F59-4D8E-A1C4-9B2F7E5D8A31}_is1`

// installedHere: this launcher's folder is the installer's InstallLocation (64-bit view, then the 32-bit view), so it
// is kind windows-installer; anything else (a zip, a copy) is windows-zip (§5.1).
func installedHere(appDir string) bool {
	norm := func(p string) string { return strings.ToLower(strings.TrimRight(filepath.Clean(p), `\/`)) }
	for _, view := range []uint32{registry.WOW64_64KEY, registry.WOW64_32KEY} {
		k, err := registry.OpenKey(registry.LOCAL_MACHINE, uninstallKey, registry.QUERY_VALUE|view)
		if err != nil {
			continue
		}
		loc, _, err := k.GetStringValue("InstallLocation")
		k.Close()
		if err == nil && loc != "" && norm(loc) == norm(appDir) {
			return true
		}
	}
	return false
}
