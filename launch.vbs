' Silent launcher for Novel Writer: runs run.bat with a hidden console window.
Option Explicit
Dim sh, fso, dir, bat
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
bat = fso.BuildPath(dir, "run.bat")
sh.CurrentDirectory = dir
sh.Run Chr(34) & bat & Chr(34), 0, False
