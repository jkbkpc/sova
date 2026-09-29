; Doplnok k inštalátoru Sovy (electron-builder ho načíta automaticky).
; Pri odinštalovaní odstráni registráciu Sovy ako prehliadača – nie pri aktualizácii.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Sova"
    DeleteRegKey HKCU "Software\Classes\SovaHTML"
    DeleteRegValue HKCU "Software\RegisteredApplications" "Sova"
  ${endIf}
!macroend
