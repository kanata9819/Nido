Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\bdb51128-5edf-5751-9a51-5ac6f27b6f3a"
Name "nido"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\nido"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\nido.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Var NoIntegration
Var Parameters

Function .onInit
  ${GetParameters} $Parameters
  ClearErrors
  ${GetOptions} $Parameters "/NOINTEGRATION" $NoIntegration
  ${IfNot} ${Errors}
    StrCpy $NoIntegration "1"
  ${Else}
    StrCpy $NoIntegration "0"
  ${EndIf}
FunctionEnd

Function .onInstSuccess
  IfSilent 0 done
  StrCmp $NoIntegration "1" done
  ClearErrors
  ${GetOptions} $Parameters "--force-run" $0
  ${IfNot} ${Errors}
    Exec '$\"$INSTDIR\nido.exe$\"'
  ${EndIf}
  done:
FunctionEnd

Section "Nido" Main
  SetShellVarContext current
  IfFileExists "$INSTDIR\nido.exe" 0 unlocked
  retry:
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\nido.exe", i 0x40000000, i 0, p 0, i 3, i 0, p 0) p.r0'
  ${If} $0 == -1
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Close Nido before installing this update. Unsaved files must be saved first." IDRETRY retry
    SetErrorLevel 2
    Abort
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0)'
  unlocked:
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*"
  IfFileExists "$INSTDIR\resources\app.asar" 0 native
    Delete "$INSTDIR\resources\app.asar"
    Delete "$INSTDIR\resources\app-update.yml"
    Delete "$INSTDIR\resources\elevate.exe"
    Delete "$INSTDIR\chrome_100_percent.pak"
    Delete "$INSTDIR\chrome_200_percent.pak"
    Delete "$INSTDIR\chrome_crashpad_handler.exe"
    Delete "$INSTDIR\d3dcompiler_47.dll"
    Delete "$INSTDIR\dxcompiler.dll"
    Delete "$INSTDIR\electron_wer.dll"
    Delete "$INSTDIR\ffmpeg.dll"
    Delete "$INSTDIR\icudtl.dat"
    Delete "$INSTDIR\libEGL.dll"
    Delete "$INSTDIR\libGLESv2.dll"
    Delete "$INSTDIR\LICENSE.electron.txt"
    Delete "$INSTDIR\LICENSES.chromium.html"
    Delete "$INSTDIR\resources.pak"
    Delete "$INSTDIR\snapshot_blob.bin"
    Delete "$INSTDIR\v8_context_snapshot.bin"
    Delete "$INSTDIR\vk_swiftshader_icd.json"
    Delete "$INSTDIR\vk_swiftshader.dll"
    Delete "$INSTDIR\vulkan-1.dll"
    RMDir /r "$INSTDIR\locales"
  native:
  WriteUninstaller "$INSTDIR\Uninstall nido.exe"
  WriteINIStr "$INSTDIR\.nido-install.ini" "Install" "NoIntegration" "$NoIntegration"
  ${If} $NoIntegration != "1"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "nido"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "kanata9819"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\nido.exe"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall nido.exe$\"'
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
    CreateShortcut "$DESKTOP\nido.lnk" "$INSTDIR\nido.exe"
    CreateShortcut "$SMPROGRAMS\nido.lnk" "$INSTDIR\nido.exe"
  ${EndIf}
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  IfFileExists "$INSTDIR\nido.exe" 0 done
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\nido.exe", i 0x40000000, i 0, p 0, i 3, i 0, p 0) p.r0'
  ${If} $0 == -1
    MessageBox MB_OK|MB_ICONEXCLAMATION "Close Nido before uninstalling."
    SetErrorLevel 2
    Abort
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0)'
  Delete "$INSTDIR\nido.exe"
  Delete "$INSTDIR\LICENCE"
  Delete "$INSTDIR\THIRD-PARTY-NOTICES.txt"
  Delete "$INSTDIR\Uninstall nido.exe"
  RMDir /r "$INSTDIR\resources"
  ReadINIStr $NoIntegration "$INSTDIR\.nido-install.ini" "Install" "NoIntegration"
  ${If} $NoIntegration != "1"
    Delete "$DESKTOP\nido.lnk"
    Delete "$SMPROGRAMS\nido.lnk"
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ${EndIf}
  Delete "$INSTDIR\.nido-install.ini"
  RMDir "$INSTDIR"
  done:
SectionEnd
