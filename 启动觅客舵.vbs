' ============================================================
'  MiKeDuo - silent launcher
'
'  Double-click this (or the desktop shortcut that points at it)
'  to open the app directly: no console window, no black flash.
'
'  It rebuilds app.js first so edits under src\ always take effect,
'  then starts Electron. The rebuild runs in a hidden window.
'
'  ASCII only on purpose: .vbs is read with the OEM/ANSI codepage,
'  so non-ASCII text here can get mis-decoded on some machines.
' ============================================================
Option Explicit

Dim fso, sh, base, electronExe, buildRc

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base

electronExe = base & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(electronExe) Then
  MsgBox "Dependencies are not installed yet." & vbCrLf & vbCrLf & _
         "Run 'npm install' in:" & vbCrLf & base & vbCrLf & vbCrLf & _
         "or double-click the batch launcher once, then use this shortcut.", _
         48, "MiKeDuo"
  WScript.Quit 1
End If

' Rebuild src\*.js -> app.js. Hidden window (0), wait for it (True).
' A failure here is not fatal: the previously built app.js still runs.
On Error Resume Next
buildRc = sh.Run("cmd /c node build.mjs", 0, True)
On Error GoTo 0

' Start the app. Normal window (1), do not wait (False) so this script exits.
sh.Run """" & electronExe & """ .", 1, False
