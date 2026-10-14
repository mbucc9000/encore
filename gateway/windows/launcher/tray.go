//go:build windows

package main

import (
	"fyne.io/systray"

	"encore-bridge/launcher/internal/core"
	"encore-bridge/launcher/internal/l10n"
)

// trayMenu is the notification-area menu:
//
//	Encore Bridge 1.1.0                  (title)
//	Ready / Streaming to 1 phone / …     (status; clickable when there is a problem to explain)
//	Open Encore Bridge                   (the admin page)
//	Setup guide…                         (the admin page's setup guide)
//	Sign in to Spotify…                  (only while the engine needs it)
//	Phone address: http://…:8095         (hidden in Showcase)
//	Encore Bridge 1.2.0 is available ▸ Update now… (installed) / Download… (zip) · What's new
//	                                     (only when a verified newer release is known; while an update runs its
//	                                     title shows the phase and its only child is Cancel update)
//	[x] Showcase mode
//	[x] Keep this PC awake while streaming
//	[x] Start with Windows
//	[x] Open admin page on start
//	Troubleshooting ▸ Open log · Open logs folder · Edit settings… · Open data folder · Fix firewall… · Restart bridge
//	Check for updates
//	About Encore Bridge
//	Quit Encore Bridge
type trayMenu struct {
	title, status                  *systray.MenuItem
	open, setup, signIn, phone     *systray.MenuItem
	showcase, keepAwake, autostart *systray.MenuItem
	openOnStart                    *systray.MenuItem
	trouble                        *systray.MenuItem
	openLog, openLogs, edit, data  *systray.MenuItem
	firewall, restart              *systray.MenuItem
	upd, updAction, updNotes       *systray.MenuItem
	updCancel, checkUpd            *systray.MenuItem
	about, quit                    *systray.MenuItem

	// last rendered state, so items are only touched when something changed
	statusText, phoneText     string
	signInShown, phoneShown   bool
	showcaseOn, showcaseOK    bool
	keepOn, autoOn, statusBtn bool
	openOnStartOn             bool
	updMenu                   core.UpdateMenu
}

func buildMenu(a *app) *trayMenu {
	m := &trayMenu{}
	m.title = systray.AddMenuItem("Encore Bridge "+displayVersion(), "")
	m.title.Disable()
	m.status = systray.AddMenuItem(tr("Starting…"), "")
	m.status.Disable()
	m.statusText = tr("Starting…")
	systray.AddSeparator()
	m.open = systray.AddMenuItem(tr("Open Encore Bridge"), tr("Open the admin page in your browser"))
	m.setup = systray.AddMenuItem(tr("Setup guide…"), tr("Open the setup guide in your browser"))
	m.signIn = systray.AddMenuItem(tr("Sign in to Spotify…"), tr("Sign the Encore engine in to your Spotify account"))
	m.signIn.Hide()
	m.phone = systray.AddMenuItem(tr("Phone address"), tr("The Home address to enter in the Encore app"))
	m.phone.Hide()
	m.upd = systray.AddMenuItem(tr("Encore Bridge update"), "")
	m.updMenu = core.UpdateTray{Kind: a.upd.kind}.Menu()
	m.updAction = m.upd.AddSubMenuItem(m.updMenu.Action, tr("Download the new version from GitHub, check it, and install it"))
	if a.upd.kind == core.KindZip {
		m.updAction.SetTooltip(tr("Open the release page on GitHub"))
	}
	m.updNotes = m.upd.AddSubMenuItem(tr("What's new"), tr("The release notes on GitHub"))
	m.updCancel = m.upd.AddSubMenuItem(tr("Cancel update"), tr("Stop the download (it continues where it stopped next time)"))
	m.updAction.Hide()
	m.updNotes.Hide()
	m.updCancel.Hide()
	m.upd.Hide()
	systray.AddSeparator()
	m.showcase = systray.AddMenuItemCheckbox(tr("Showcase mode"), tr("Hide names, addresses and codes on this PC's screens"), false)
	m.showcase.Disable()
	a.prefsMu.Lock()
	m.keepOn, m.openOnStartOn = a.prefs.KeepAwake, a.prefs.OpenOnStart
	a.prefsMu.Unlock()
	m.keepAwake = systray.AddMenuItemCheckbox(tr("Keep this PC awake while streaming"), tr("Don't let Windows sleep while a phone is listening"), m.keepOn)
	m.autoOn = autostartEnabled(a.exe)
	m.autostart = systray.AddMenuItemCheckbox(tr("Start with Windows"), tr("Start Encore Bridge when you sign in to Windows"), m.autoOn)
	m.openOnStart = systray.AddMenuItemCheckbox(tr("Open admin page on start"), tr("Open the admin page in your browser each time Encore Bridge starts"), m.openOnStartOn)
	systray.AddSeparator()
	m.trouble = systray.AddMenuItem(tr("Troubleshooting"), "")
	m.openLog = m.trouble.AddSubMenuItem(tr("Open log"), "")
	m.openLogs = m.trouble.AddSubMenuItem(tr("Open logs folder"), "")
	m.edit = m.trouble.AddSubMenuItem(tr("Edit settings…"), tr("settings.env, in Notepad"))
	m.data = m.trouble.AddSubMenuItem(tr("Open data folder"), "")
	m.firewall = m.trouble.AddSubMenuItem(tr("Fix firewall…"), tr("Check that Windows Firewall lets your phone in"))
	m.restart = m.trouble.AddSubMenuItem(tr("Restart bridge"), "")
	m.checkUpd = systray.AddMenuItem(tr("Check for updates"), tr("Ask GitHub whether a newer Encore Bridge is out"))
	m.about = systray.AddMenuItem(tr("About Encore Bridge"), "")
	m.quit = systray.AddMenuItem(tr("Quit Encore Bridge"), tr("Stop the bridge and remove this icon"))
	return m
}

// update renders a view. The caller holds app.mu and must not be the menu loop.
func (m *trayMenu) update(a *app, v core.View) {
	if v.Headline != m.statusText {
		m.status.SetTitle(v.Headline)
		m.statusText = v.Headline
	}
	if btn := v.Problem != ""; btn != m.statusBtn {
		if btn {
			m.status.Enable()
			m.status.SetTooltip(tr("What to do"))
		} else {
			m.status.Disable()
			m.status.SetTooltip("")
		}
		m.statusBtn = btn
	}
	if v.SignInNeeded != m.signInShown {
		if v.SignInNeeded {
			m.signIn.Show()
		} else {
			m.signIn.Hide()
		}
		m.signInShown = v.SignInNeeded
	}
	phone := ""
	switch {
	case v.PhoneHidden:
		phone = tr("Phone address: hidden (Showcase)")
	case v.PhoneURL != "":
		phone = trf("Phone address: {url}", l10n.Vars{"url": v.PhoneURL})
	}
	if phone != m.phoneText {
		if phone != "" {
			m.phone.SetTitle(phone)
		}
		m.phoneText = phone
	}
	if shown := phone != ""; shown != m.phoneShown {
		if shown {
			m.phone.Show()
		} else {
			m.phone.Hide()
		}
		m.phoneShown = shown
	}
	ok, on := v.Showcase != nil, v.Showcase != nil && *v.Showcase
	if ok != m.showcaseOK {
		if ok {
			m.showcase.Enable()
		} else {
			m.showcase.Disable()
		}
		m.showcaseOK = ok
	}
	if on != m.showcaseOn {
		setChecked(m.showcase, on)
		m.showcaseOn = on
	}
	a.prefsMu.Lock()
	keep, openOnStart := a.prefs.KeepAwake, a.prefs.OpenOnStart
	a.prefsMu.Unlock()
	if keep != m.keepOn {
		setChecked(m.keepAwake, keep)
		m.keepOn = keep
	}
	if openOnStart != m.openOnStartOn {
		setChecked(m.openOnStart, openOnStart)
		m.openOnStartOn = openOnStart
	}
	if auto := autostartEnabled(a.exe); auto != m.autoOn {
		setChecked(m.autostart, auto)
		m.autoOn = auto
	}
	m.updateItem(v.Update.Menu())
}

// updateItem renders the "is available" item (§5.2): hidden unless a verified newer release is known or an update
// runs.
func (m *trayMenu) updateItem(um core.UpdateMenu) {
	old := m.updMenu
	if um == old {
		return
	}
	if um.Title != "" && um.Title != old.Title {
		m.upd.SetTitle(um.Title)
	}
	show := func(it *systray.MenuItem, now, before bool) {
		if now != before {
			if now {
				it.Show()
			} else {
				it.Hide()
			}
		}
	}
	show(m.updAction, um.ShowAction, old.ShowAction)
	show(m.updNotes, um.ShowNotes, old.ShowNotes)
	show(m.updCancel, um.ShowCancel, old.ShowCancel)
	show(m.upd, um.Title != "", old.Title != "")
	m.updMenu = um
}

func setChecked(it *systray.MenuItem, on bool) {
	if on {
		it.Check()
	} else {
		it.Uncheck()
	}
}

// loop dispatches clicks. Every action runs on its own goroutine so the menu never waits for a dialog; systray drops
// clicks nobody is receiving.
func (m *trayMenu) loop(a *app) {
	for {
		var act func()
		select {
		case <-a.done:
			return
		case <-m.status.ClickedCh:
			act = a.showProblem
		case <-m.open.ClickedCh:
			act = a.openAdmin
		case <-m.setup.ClickedCh:
			act = a.openSetupGuide
		case <-m.signIn.ClickedCh:
			act = a.signIn
		case <-m.phone.ClickedCh:
			act = a.phoneInfo
		case <-m.showcase.ClickedCh:
			act = a.toggleShowcase
		case <-m.keepAwake.ClickedCh:
			act = a.toggleKeepAwake
		case <-m.autostart.ClickedCh:
			act = a.toggleAutostart
		case <-m.openOnStart.ClickedCh:
			act = a.toggleOpenOnStart
		case <-m.openLog.ClickedCh:
			act = a.openLog
		case <-m.openLogs.ClickedCh:
			act = a.openLogs
		case <-m.edit.ClickedCh:
			act = a.editSettings
		case <-m.data.ClickedCh:
			act = a.openData
		case <-m.firewall.ClickedCh:
			act = func() { a.once("firewall", a.fixFirewall) }
		case <-m.restart.ClickedCh:
			act = a.restartBridge
		case <-m.updAction.ClickedCh:
			act = func() { a.once("update", a.upd.actionClicked) }
		case <-m.updNotes.ClickedCh:
			act = a.upd.notesClicked
		case <-m.updCancel.ClickedCh:
			act = a.upd.cancelInstall
		case <-m.checkUpd.ClickedCh:
			act = func() { a.once("update-check", func() { a.upd.manualCheck(true) }) }
		case <-m.about.ClickedCh:
			act = a.about
		case <-m.quit.ClickedCh:
			act = a.quit
		}
		a.spawn("menu action", act)
	}
}
