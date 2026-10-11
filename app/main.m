#import <UIKit/UIKit.h>
#import "ENAppDelegate.h"
#import "ENDiag.h"
#import "ENCompat.h"

int main(int argc, char *argv[]) {
	ENCompatInstall();                              // 1.1: first of all (iOS 5's fallbacks; nothing on iOS 6)
	ENLaunchStart = CFAbsoluteTimeGetCurrent();     // 0.5: launch_ms counts from here (ENDiag launchFinished)
	@autoreleasepool {
		return UIApplicationMain(argc, argv, nil, NSStringFromClass([ENAppDelegate class]));
	}
}
