' ============================================================
'  MiKeDuo - TRIAL launcher (what a paying customer sees BEFORE buying)
'
'  Identical to the dev launcher except it does NOT set MKD_DEV_TIER,
'  so the app runs as an unactivated trial. Use this to check the
'  things only a trial user ever sees:
'
'    - the 20-lead cap and the locked-row state
'    - the upgrade wall and its three buttons
'    - the cloud-model section rendered as locked
'    - the trial watermark line in exported CSV files
'
'  Those are exactly the parts that are easy to break and impossible
'  to notice from the dev launcher, because there everything is unlocked.
'
'  ASCII only on purpose: .vbs is read with the OEM/ANSI codepage,
'  so non-ASCII text here can get mis-decoded on some machines.
' ============================================================
Option Explicit

Dim fso, sh, base, electronExe

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

' Rebuild src\*.js -> app.js. Hidden window (0), wait for it (True).
On Error Resume Next
sh.Run "cmd /c node build.mjs", 0, True
On Error GoTo 0

sh.Run """" & electronExe & """ .", 1, False
