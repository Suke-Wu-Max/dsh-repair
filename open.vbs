' ============================================================
'  dsh-tudian : double-click entry
'  Opens design.html in the default browser.
'  IMPORTANT: this file must stay pure ASCII (no Chinese chars),
'  otherwise Windows Script Host fails with error 800A0408.
' ============================================================
Option Explicit

Dim fso, shell, here, target

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
target = fso.BuildPath(here, "design.html")

If Not fso.FileExists(target) Then
  MsgBox "design.html not found in:" & vbCrLf & here, 16, "dsh-tudian"
  WScript.Quit 1
End If

shell.Run """" & target & """", 1, False
WScript.Quit 0
