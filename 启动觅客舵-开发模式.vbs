' ============================================================
'  MiKeDuo - DEV launcher (unlocked / VIP tier)
'
'  Same as the normal silent launcher, but sets MKD_DEV_TIER=pro
'  so the app runs as if activated. Use this while debugging the
'  business logic: the trial build hard-disables the AI engine
'  (aiEnabled() returns false), so most of the pipeline never runs.
'
'  This only works on an UNPACKAGED build. main.js ignores
'  MKD_DEV_TIER when app.isPackaged is true, so a customer running
'  the installed .exe cannot unlock anything with it.
'
'  Set to basic / pro / coach to debug a different tier.
'  Use the normal launcher to see what a trial user actually sees.
'
'  ASCII only on purpose: .vbs is read with the OEM/ANSI codepage,
'  so non-ASCII text here can get mis-decoded on some machines.
' ============================================================
Option Explicit

Dim fso, sh, env, base, electronExe

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base

electronExe = base & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(electronExe) Then
  MsgBox "Dependencies are not installed yet." & vbCrLf & vbCrLf & _
         "Run 'npm install' in:" & vbCrLf & base, 48, "MiKeDuo"
  WScript.Quit 1
End If

' Process-scoped only: does not touch the user or system environment.
Set env = sh.Environment("PROCESS")
env("MKD_DEV_TIER") = "pro"

' Rebuild src\*.js -> app.js. Hidden window (0), wait for it (True).
On Error Resume Next
sh.Run "cmd /c node build.mjs", 0, True
On Error GoTo 0

sh.Run """" & electronExe & """ .", 1, False
