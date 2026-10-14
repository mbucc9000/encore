# Encore Icons: the SpringBoard add-on that swaps Encore's home screen icon (DESIGN-APP-ICONS.md §6).
# A Theos subproject of app/ (SUBPROJECTS in app/Makefile): `make package FINALPACKAGE=1` in app/ puts EncoreIcons.dylib
# and EncoreIcons.plist into Encore's own package (add EI_DEBUG=1 for /var/mobile/Library/Logs/EncoreIcons.log).
# No control, no layout/ and no after-install here: Encore's postinst only asks Cydia for its respring.
TARGET = iphone:clang:6.1:5.0
ARCHS = armv7

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = EncoreIcons
EncoreIcons_FILES = Tweak.x
EncoreIcons_FRAMEWORKS = UIKit Foundation CoreGraphics
EncoreIcons_CFLAGS = -fobjc-arc
ifeq ($(EI_DEBUG),1)
EncoreIcons_CFLAGS += -DEI_DEBUG=1
endif

include $(THEOS)/makefiles/tweak.mk
