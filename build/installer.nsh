; Doplnok k inštalátoru Sovy (electron-builder ho načíta automaticky).
!include FileFunc.nsh

; Zápis do denníka Sovy (%APPDATA%\Sova\sova.log) – koľko trvá inštalácia pri aktualizácii
!macro sovaLog TEXT
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  ${GetTime} "" "LS" $0 $1 $2 $3 $4 $5 $6
  CreateDirectory "$APPDATA\Sova"
  FileOpen $7 "$APPDATA\Sova\sova.log" a
  ${If} $7 != ""
    FileSeek $7 0 END
    FileWrite $7 "$2-$1-$0T$4:$5:$6Z [instalator] ${TEXT}$\r$\n"
    FileClose $7
  ${EndIf}
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customInit
  !insertmacro sovaLog "spusteny (po kontrole antivirusom)"
!macroend

!macro customInstall
  !insertmacro sovaLog "subory nainstalovane, spustam Sovu"
!macroend

; Pri odinštalovaní odstráni registráciu Sovy ako prehliadača – nie pri aktualizácii.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Sova"
    DeleteRegKey HKCU "Software\Classes\SovaHTML"
    DeleteRegValue HKCU "Software\RegisteredApplications" "Sova"
  ${endIf}
!macroend
