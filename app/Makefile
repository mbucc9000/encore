TARGET = iphone:clang:6.1:5.0
ARCHS = armv7

include $(THEOS)/makefiles/common.mk

APPLICATION_NAME = Encore
# app 1.1.0 (iOS 5): ENCompat first (ENCompatInstall() is main()'s first call: the iOS 5 fallbacks, ios5/AUDIT.md). The
# deployment target is 5.0 (the iOS 6-only symbols are weak imports); never add -fobjc-arc to LDFLAGS (the toolchain has
# no arclite: ENCompat adds the subscripting methods instead) and never use @available (no ___isOSVersionAtLeast)
# app 0.5 (ARCH-0.5.md): core + DATA (ENUtil ENModel ENCatalog ENImageCache) + UI (theme, cells, lists, tabs, screens) +
# ACTIONS (ENTrackActions ENAddToPlaylistViewController ENHUD ENHeartButton)
Encore_FILES = ENCompat.m main.m ENAppDelegate.m ENDiag.m ENKeychain.m ENGateway.m ENStreamPlayer.m ENPlayback.m ENSetupViewController.m ENPlayerViewController.m
Encore_FILES += ENUtil.m ENModel.m ENCatalog.m ENImageCache.m
Encore_FILES += ENTheme.m ENListCell.m ENListViewController.m ENTabBarController.m ENMiniPlayer.m ENNowPlayingViewController.m
Encore_FILES += ENPlaylistsViewController.m ENLibraryViewController.m ENTrackListViewController.m ENArtistViewController.m
Encore_FILES += ENSearchViewController.m ENSearchSongsViewController.m
Encore_FILES += ENTrackActions.m ENAddToPlaylistViewController.m ENHUD.m ENHeartButton.m
# app 0.6 (DESIGN-4b §6, ARCH-0.5.md §10): Jam. DATA ENJam; UI ENJamViewController ENJamBar ENAvatarView ENQueueViewController;
# ACTIONS ENJamActions (MFMessageComposeViewController -> MessageUI)
Encore_FILES += ENJam.m ENJamViewController.m ENJamBar.m ENAvatarView.m ENQueueViewController.m ENJamActions.m
Encore_FILES += ENHomeViewController.m ENShelfCell.m ENProfileViewController.m
# app 0.8 (DESIGN-LYRICS.md): synced lyrics. DATA ENLyrics; UI ENLyricsView (over Now Playing's art)
Encore_FILES += ENLyrics.m ENLyricsView.m
# app 0.9 (DESIGN-0.9.md §2): pinned playlists. DATA ENPins (NSUserDefaults, per phone)
Encore_FILES += ENPins.m
# app 0.9.3 (DESIGN-JAM-UI.md): the Jam screen's songs. ENQueueEditor: Up Next's edit FIFO, shared by Up Next and the Jam screen
Encore_FILES += ENQueueEditor.m
# app 0.9.5: Search's "Recent searches" (the items tapped). DATA ENRecents (NSUserDefaults, per phone)
Encore_FILES += ENRecents.m
# app 0.10.0 (DESIGN-5 §2.1, Drop 3a; ARCH-0.5.md §12): the green chrome. ENSheets (ENActionSheet / ENAlertView), the grouped kit
# ENGroupedViewController (with ENGroupedCell) and ENChoiceViewController (Settings -> Appearance). Dark mode is off (EN_DARK_MODE)
Encore_FILES += ENSheets.m ENGroupedViewController.m ENChoiceViewController.m
# app 0.11.0 (DESIGN-5 §2.2, Drop 3b; ARCH-0.5.md §"Drop 3b"): the grouped Settings screen (tab 4; the Phase 2 screen,
# ENPlayerViewController, is its About -> Diagnostics)
Encore_FILES += ENSettingsViewController.m
# app 0.11.0 (DESIGN-PROFILES.md §4; ARCH-0.5.md §"Profiles"): other people's profiles. ENPeopleViewController (people lists:
# followers, following, "See all profiles"), ENUserPlaylistsViewController (a person's public playlists), ENUserRows (the
# ENListCell (ENUser) row)
Encore_FILES += ENPeopleViewController.m ENUserPlaylistsViewController.m ENUserRows.m
# app 1.0.0 (DESIGN-5 §2.3, Drop 3c; ARCH-0.5.md §15): every screen restyled. No new .m (50 above, each once); the new
# Resources/SetupIcon@2x.png (Setup's 76 pt icon, from tools/make_art.py) ships with the rest of Resources/
# app 1.1.0 (RELEASE-PLAN R2a, D1-D5): Anonymous Mode. DATA ENAnon (the switches, made-up names, device / playlist / message
# masking; read by the model getters and the screens; Settings → Privacy)
Encore_FILES += ENAnon.m ENLang.m
# app 1.1.0 (RELEASE-PLAN R2c): 3.5-inch screens (iPhone 4 / 4S, iPod touch 4). No new .m; the 3.5-inch launch images
# Resources/Default.png (320 x 480) and Default@2x.png (640 x 960), from tools/make_art.py, ship with the rest of Resources/
# beside the 4-inch Default-568h@2x.png
# (update notice, after 1.3.0) the new-version notice: ENUpdateNotice (/v1/status `update` -> a once-per-version alert with
# Open Cydia, and Settings' Update Available row)
Encore_FILES += ENUpdateNotice.m
Encore_FRAMEWORKS = UIKit Foundation CoreGraphics QuartzCore AudioToolbox AVFoundation MediaPlayer Security SystemConfiguration MessageUI
Encore_CFLAGS = -fobjc-arc
# EncoreLinks (the tweak that opens tapped Spotify links in Encore) isn't released yet: Settings' "Open Spotify Links" row is
# built only with `make package EN_ENCORE_LINKS=1` (ENSettingsViewController.m; off by default)
ifeq ($(EN_ENCORE_LINKS),1)
Encore_CFLAGS += -DEN_ENCORE_LINKS=1
endif
Encore_CODESIGN_FLAGS = -Sentitlements.plist

include $(THEOS_MAKE_PATH)/application.mk

after-install::
	install.exec "su mobile -c uicache; killall -9 Encore 2>/dev/null || true"
