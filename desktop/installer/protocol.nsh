; NSIS does not consume electron-builder's generic `protocols` option.
; Use the selected install scope and registry view already set by the template.
!define PLANNER_PROTOCOL_KEY "Software\Classes\tteodori-planner"
; End Chromium switch parsing before the externally supplied URL argument.
!define PLANNER_PROTOCOL_COMMAND '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" -- $\"%1$\"'

!macro customInstall
  WriteRegStr SHCTX "${PLANNER_PROTOCOL_KEY}" "" "URL:tteodori-planner"
  WriteRegStr SHCTX "${PLANNER_PROTOCOL_KEY}" "URL Protocol" ""
  WriteRegStr SHCTX "${PLANNER_PROTOCOL_KEY}\DefaultIcon" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0'
  WriteRegStr SHCTX "${PLANNER_PROTOCOL_KEY}\shell\open\command" "" "${PLANNER_PROTOCOL_COMMAND}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0) v'
!macroend

!macro customUnInstall
  ; A later install or a different app may own the scheme now. Remove only our
  ; exact command, including its arguments; never delete another handler.
  Push $0
  Push $1
  ReadRegStr $0 SHCTX "${PLANNER_PROTOCOL_KEY}\shell\open\command" ""
  StrCpy $1 "${PLANNER_PROTOCOL_COMMAND}"
  ${If} $0 == $1
    DeleteRegKey SHCTX "${PLANNER_PROTOCOL_KEY}"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0) v'
  ${EndIf}
  Pop $1
  Pop $0
!macroend
