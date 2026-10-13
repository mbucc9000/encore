package core

import "encore-bridge/launcher/internal/l10n"

// tr and trf translate the tray texts this package builds (internal/l10n: English while no language is in use). Their
// first argument is always one string literal, the English text. The localization helper (bridge_l10n.py) only reads
// the launcher's own folder, so ../../l10n_core.go lists the same texts; TestTrayTextsListed keeps the two equal.
func tr(s string) string { return l10n.Tr(s) }

func trf(s string, v vars) string { return l10n.Trf(s, v) }

type vars = l10n.Vars
