; File-only fixture: no registry, shortcuts, process termination, or app launch.
Unicode true
SilentInstall silent
RequestExecutionLevel user
OutFile "${TEST_DIR}\fixture-${NIDO_TEST_CASE}.exe"
InstallDir "${TEST_DIR}\target-${NIDO_TEST_CASE}"
!include "LogicLib.nsh"
!addplugindir /x86-unicode "${PLUGIN_DIR}"
!addincludedir "${TEMPLATE_DIR}"
!define APP_EXECUTABLE_FILENAME "nido.exe"
!include "${BUILD_RESOURCES_DIR}\installer.nsh"
!include "installer.nsh"
LangString appCannotBeClosed 1033 "Close the fixture and retry."
LangString decompressionFailed 1033 "Fixture extraction failed."

Section
  InitPluginsDir
  SetOutPath "$INSTDIR"
  !insertmacro extractUsing7za "${PAYLOAD}"
  FileOpen $0 "$INSTDIR\installed.txt" w
  IfFileExists "$PLUGINSDIR\7z-out\nido.exe" copied moved
  copied:
    FileWrite $0 "copied"
    Goto finished
  moved:
    FileWrite $0 "moved"
  finished:
  FileClose $0
  SetErrorLevel 0
SectionEnd
