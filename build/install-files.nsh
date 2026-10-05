!macro extractUsing7za FILE
  Push $OUTDIR
  CreateDirectory "$PLUGINSDIR\7z-out"
  SetOutPath "$PLUGINSDIR\7z-out"
  Nsis7z::Extract "${FILE}"
  Pop $R0

  ; A failed extraction must not replace the target with an empty directory.
  IfFileExists "$PLUGINSDIR\7z-out\${APP_EXECUTABLE_FILENAME}" 0 nidoExtractionFailed
  IfFileExists "$PLUGINSDIR\7z-out\resources\app.asar" 0 nidoExtractionFailed

  ; The old version has already been uninstalled. Moving the staged directory
  ; avoids copying every bundled Neovim/debugger file a second time.
  ; RMDir is deliberately non-recursive: an existing non-empty target is kept.
  SetOutPath "$PLUGINSDIR"
  RMDir "$R0"
  ClearErrors
  Rename "$PLUGINSDIR\7z-out" "$R0"
  IfErrors nidoCopyFiles nidoFilesInstalled

  nidoCopyFiles:
    ; A different volume or a non-empty target needs the standard copy path.
    SetOutPath "$R0"
    StrCpy $R1 0

  nidoRetryCopy:
    IntOp $R1 $R1 + 1
    ClearErrors
    CopyFiles /SILENT "$PLUGINSDIR\7z-out\*" "$OUTDIR"
    IfErrors 0 nidoFilesInstalled

    ${if} $R1 < 5
      Sleep 1000
      Goto nidoRetryCopy
    ${endif}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY nidoRetryCopy
    ; Never report success or launch the app after a failed file transfer.
    SetErrorLevel 2
    Quit

  nidoFilesInstalled:
    SetOutPath "$R0"
    Goto nidoExtractionDone

  nidoExtractionFailed:
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)" /SD IDOK
    SetErrorLevel 2
    Quit

  nidoExtractionDone:
!macroend
