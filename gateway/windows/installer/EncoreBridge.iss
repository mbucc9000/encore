; Encore Bridge for Windows: installer script (Inno Setup 6.7).
;
; Built by ../build.sh in the encore-winbuild-package image, from the staging folder that ../bundle/bundle.sh
; assembled (the same folder the portable zip is made from). By hand:
;   ISCC.exe /DAppVersion=1.1.0 /DStagingDir=<staging>\Encore Bridge /DOutputDir=<out> EncoreBridge.iss
; (in English only: bundle.sh adds the other languages, see [Languages] below).
;
; What it does (D17): installs per machine into Program Files; adds a Windows Firewall rule that lets phones reach
; the bridge on TCP 8095 on Private and Domain networks; adds a Start-menu entry and, as an option, "Start with
; Windows" for the signed-in user; quits a running Encore Bridge before replacing files. It asks nothing else: its
; finish page starts Encore Bridge, which opens the setup guide on the admin page, and everything else (the music
; account, the phone, listening away from home) is set up there. The uninstaller removes the firewall rules and the
; Start with Windows entry, and asks whether to delete the user's data (%LOCALAPPDATA%\Encore) or keep it for a later
; reinstall.
;
; Update mode (DESIGN-UPDATES.md §5.6, §5.7): the tray launcher's "Update now" starts this Setup, after it verified it
; against Encore's signed checksum list, as
;   EncoreBridge-<ver>-setup.exe /SILENT /SUPPRESSMSGBOXES /NORESTART /SP- /NOCANCEL /ENCOREUPDATE=1 /LOG="<file>"
; with the verb "open": Setup elevates itself (Windows asks the user), so it still knows the signed-in user. (/NOCANCEL:
; [InstallDelete] below empties the old program folders and Inno Setup doesn't put replaced files back, so a cancel
; halfway would leave neither version complete.) It then upgrades in place like any upgrade (asks the running launcher
; to quit, replaces the program files, never touches the user's data in %LOCALAPPDATA%\Encore), keeps the user's
; current Start with Windows choice (the autostart entries don't run), and starts the new launcher with --updated. If it
; stopped the launcher but didn't finish, it starts the old one again with --update-failed, so the bridge doesn't stay
; stopped; if Setup had already removed old files, that launcher points the user to the downloaded installer instead.
;
; Copyright (C) Encore contributors. GPL-3.0-or-later.

#ifndef AppVersion
  #error Define AppVersion, for example /DAppVersion=1.1.0
#endif
#ifndef StagingDir
  #error Define StagingDir: the folder that holds "Encore Bridge.exe" and the rest of the bundle
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif
#ifndef NumericVersion
  #define NumericVersion AppVersion
#endif
#ifndef IconFile
  #define IconFile "..\launcher\assets\encore.ico"
#endif
; LanguagesFile: the other languages, made at build time by make_languages.py (bundle.sh passes it)

#define AppName "Encore Bridge"
#define AppExe "Encore Bridge.exe"
#define FwRule "Encore Bridge (phone)"
#define FwPort "8095"
#define LauncherMutex "Local\EncoreBridgeLauncher"
#define RunKey "Software\Microsoft\Windows\CurrentVersion\Run"

[Setup]
; The AppId never changes: upgrades find the existing installation by it.
AppId={{6E0C2B7A-3F59-4D8E-A1C4-9B2F7E5D8A31}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Encore contributors
AppCopyright=Copyright (C) Encore contributors. GPL-3.0-or-later.
VersionInfoVersion={#NumericVersion}
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#NumericVersion}
VersionInfoDescription={#AppName} Setup
VersionInfoCompany=Encore contributors
VersionInfoCopyright=Copyright (C) Encore contributors. GPL-3.0-or-later.
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Node.js 22 needs Windows 10 or later
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=EncoreBridge-{#AppVersion}-setup
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
; a running Encore Bridge is asked to quit in PrepareToInstall / InitializeUninstall below
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
; the language is the Windows display language's (like the tray's); any other language gets English, no question asked
ShowLanguageDialog=no

[Languages]
; English first: the fallback. The other languages are added after the English texts below.
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
; Setup's own texts, in English. The English text is the key of their translations (gateway\src\i18n\<code>.json):
; change a text here and its translations follow when the dictionaries are next made.
AutostartTask=Start Encore Bridge when I sign in to Windows (recommended: phones can only play while it runs)
DesktopIconTask=Create a desktop shortcut
OptionsGroup=Options:
StartMenuComment=Runs the bridge for the Encore app
FirewallStatus=Setting up Windows Firewall...
RunNewInstall=Start Encore Bridge and open the setup guide
RunUpgrade=Start Encore Bridge now
StillRunningSetup=Encore Bridge is still running. Quit it from its icon in the notification area (Quit Encore Bridge), then run Setup again.
StillRunningUninstall=Encore Bridge is still running. Quit it from its icon in the notification area (Quit Encore Bridge), then uninstall again.
DeleteDataQuestion=Also delete your Encore Bridge data?
DeleteDataWhat=This removes your settings, paired phones, sign-ins, cache and logs for this Windows user:
DeleteDataKeep=Choose No to keep them for a later reinstall.

; The other languages: those of the bridge's dictionaries (gateway\src\i18n\<code>.json) that Inno Setup has its own
; translation for. make_languages.py writes their [Languages] entries and their [CustomMessages] (from the
; dictionaries, keyed by the English texts above) into LanguagesFile at build time. It must come AFTER the English
; texts: an unprefixed message replaces every language's, including a translation listed before it.
#ifdef LanguagesFile
  #include LanguagesFile
#endif

[Tasks]
Name: "autostart"; Description: "{cm:AutostartTask}"; GroupDescription: "{cm:OptionsGroup}"
Name: "desktopicon"; Description: "{cm:DesktopIconTask}"; GroupDescription: "{cm:OptionsGroup}"; Flags: unchecked

[InstallDelete]
; An upgrade replaces these folders completely, so no file from an older version is left behind in them.
Type: filesandordirs; Name: "{app}\gateway"
Type: filesandordirs; Name: "{app}\licenses"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\engine"
Type: filesandordirs; Name: "{app}\ffmpeg"

[Files]
Source: "{#StagingDir}\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StagingDir}\*"; Excludes: "\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Comment: "{cm:StartMenuComment}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
; Firewall: replace this installation's rule for TCP {#FwPort} (rules of the same name for other ports, made by the
; tray's "Fix firewall" after a PORT change, are kept), then add it for this folder's node.exe. The rule doesn't limit
; the remote address, so connections the router forwards from outside (the setup guide's "Listen away from home"
; step) get in through it too, as long as the network is Private.
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#FwRule}"" dir=in protocol=tcp localport={#FwPort}"; Flags: runhidden; StatusMsg: "{cm:FirewallStatus}"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""{#FwRule}"" dir=in action=allow program=""{app}\runtime\node.exe"" enable=yes profile=private,domain protocol=tcp localport={#FwPort} description=""Lets your phone reach Encore Bridge on home (Private) networks."""; Flags: runhidden; StatusMsg: "{cm:FirewallStatus}"
; Start with Windows is per user (HKCU), so it is set as the signed-in user, not as the administrator.
; An update (/ENCOREUPDATE=1) keeps the user's current choice: it may have changed in the tray since the install, so
; the task Setup remembers could be stale.
Filename: "{app}\{#AppExe}"; Parameters: "--autostart-enable"; Flags: runasoriginaluser waituntilterminated; Tasks: autostart; Check: not IsUpdateRun
Filename: "{app}\{#AppExe}"; Parameters: "--autostart-disable"; Flags: runasoriginaluser waituntilterminated; Tasks: not autostart; Check: not IsUpdateRun
; The launcher opens the admin page once the bridge answers: it shows the setup guide while setup isn't complete.
Filename: "{app}\{#AppExe}"; Description: "{cm:RunNewInstall}"; Flags: postinstall nowait skipifsilent runasoriginaluser; Check: not IsUpgrade
Filename: "{app}\{#AppExe}"; Description: "{cm:RunUpgrade}"; Flags: postinstall nowait skipifsilent runasoriginaluser; Check: IsUpgrade
; Update mode: Setup runs silently, so the two entries above don't run; the new launcher starts with --updated (the
; browser opens only with the tray's "Open admin page on start"), as the signed-in user.
Filename: "{app}\{#AppExe}"; Parameters: "--updated"; Flags: nowait runasoriginaluser; Check: IsUpdateRun

[UninstallRun]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#FwRule}"""; Flags: runhidden; RunOnceId: "DelFwRuleByName"
; rules Windows made for this node.exe from its own prompt (a portable copy run from this folder), Allow or Block
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=all program=""{app}\runtime\node.exe"""; Flags: runhidden; RunOnceId: "DelFwRuleByProgram"

[UninstallDelete]
Type: dirifempty; Name: "{app}"

[Code]
var
  // Update mode: Setup stopped a running launcher / finished installing; the launcher it stopped
  StoppedLauncher, InstallDone: Boolean;
  StoppedLauncherExe: String;

// An upgrade: Setup found an earlier installation of this AppId. (Decided when Setup starts, so it stays the same
// after the files are installed.)
function IsUpgrade(): Boolean;
begin
  Result := WizardForm.PrevAppDir <> '';
end;

// Update mode: started by the launcher's "Update now" with /ENCOREUPDATE=1.
function IsUpdateRun(): Boolean;
begin
  Result := ExpandConstant('{param:ENCOREUPDATE|0}') = '1';
end;

function LauncherRunning(): Boolean;
begin
  Result := CheckForMutexes('{#LauncherMutex}');
end;

function WaitLauncherGone(Seconds: Integer): Boolean;
var
  I: Integer;
begin
  for I := 1 to Seconds * 2 do
  begin
    if not LauncherRunning() then
    begin
      Result := True;
      exit;
    end;
    Sleep(500);
  end;
  Result := not LauncherRunning();
end;

// Setup: ask any running Encore Bridge in this session (installed or a portable copy) to quit gracefully. The new
// launcher is extracted to the temporary folder and run as the signed-in user with --quit, which signals it.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  if not LauncherRunning() then
    exit;
  ExtractTemporaryFile('{#AppExe}');
  if not ExecAsOriginalUser(ExpandConstant('{tmp}\{#AppExe}'), '--quit', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Log('Could not run --quit: ' + SysErrorMessage(ResultCode));
  if not WaitLauncherGone(30) then
    Result := CustomMessage('StillRunningSetup')
  else
  begin
    // the launcher that ran from this installation, started again by DeinitializeSetup if the update doesn't finish
    StoppedLauncher := True;
    StoppedLauncherExe := ExpandConstant('{app}\{#AppExe}');
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    InstallDone := True;
end;

// Update mode: Setup stopped the launcher but didn't finish (an error, or it was cancelled during the install). Start
// the installed launcher again, as the signed-in user, so the bridge never stays stopped. Inno Setup doesn't put back
// files it already replaced; if the folder is now incomplete, the launcher says so and points to the downloaded,
// checked installer (%LOCALAPPDATA%\Encore\updates\<ver>\) to run again.
procedure DeinitializeSetup();
var
  ResultCode: Integer;
begin
  if IsUpdateRun() and StoppedLauncher and not InstallDone and (StoppedLauncherExe <> '') and FileExists(StoppedLauncherExe) then
  begin
    Log('The update did not finish: starting Encore Bridge again with --update-failed');
    if not ExecAsOriginalUser(StoppedLauncherExe, '--update-failed', '', SW_SHOWNORMAL, ewNoWait, ResultCode) then
      Log('Could not start Encore Bridge again: ' + SysErrorMessage(ResultCode));
  end;
end;

// Uninstall: the same, with the installed launcher.
function InitializeUninstall(): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  if not LauncherRunning() then
    exit;
  if FileExists(ExpandConstant('{app}\{#AppExe}')) then
    Exec(ExpandConstant('{app}\{#AppExe}'), '--quit', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if not WaitLauncherGone(30) then
  begin
    if not UninstallSilent() then
      MsgBox(CustomMessage('StillRunningUninstall'), mbError, MB_OK);
    Result := False;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir, RunValue: String;
begin
  if CurUninstallStep <> usPostUninstall then
    exit;

  // Start with Windows: only this Windows user's entry, and only if it points into this installation.
  if RegQueryStringValue(HKCU, '{#RunKey}', '{#AppName}', RunValue) then
    if Pos(Lowercase(ExpandConstant('{app}\')), Lowercase(RunValue)) > 0 then
      RegDeleteValue(HKCU, '{#RunKey}', '{#AppName}');

  // The user's data: settings.env, paired phones, sign-ins, cache and logs. Kept unless the user says otherwise; a
  // silent uninstall always keeps it.
  DataDir := ExpandConstant('{localappdata}\Encore');
  if DirExists(DataDir) and not UninstallSilent() then
    if MsgBox(CustomMessage('DeleteDataQuestion') + #13#10#13#10 +
              CustomMessage('DeleteDataWhat') + #13#10 +
              DataDir + #13#10#13#10 +
              CustomMessage('DeleteDataKeep'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(DataDir, True, True, True);
end;
