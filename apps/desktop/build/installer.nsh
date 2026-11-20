; electron-builder includes build/installer.nsh in the NSIS script by default.
!include x64.nsh

; With an arm64 archive present, the stock template skips its 64-bit check, so a 32-bit
; Windows install would fail extracting a missing app archive instead of explaining why.
!macro customInit
  ${IfNot} ${RunningX64}
  ${AndIfNot} ${IsNativeARM64}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(x64WinRequired)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend
