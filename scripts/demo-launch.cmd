@echo off
REM CC2CC Demo Debate — 5-agent layout in Windows Terminal
REM
REM Layout:
REM +-----------+-----+-----+
REM |           |Crit |Real |
REM | Moderator +-----+-----+
REM |           |Opti |Wild |
REM +-----------+-----+-----+
REM
REM After launch: confirm channel warning, paste persona prompts from
REM docs/Demo.md into each pane, then start the debate via moderator.

set DIR=D:\cc2cc
if not exist "%DIR%" (
    echo ERROR: Bridge directory %DIR% not found. Run "cc2cc init" first.
    exit /b 1
)
set CLAUDE=claude --dangerously-skip-permissions --dangerously-load-development-channels server:cc2cc

powershell -NoProfile -Command "Start-Process wt -ArgumentList 'new-tab --title Moderator -d %DIR% cmd.exe /k %CLAUDE% ; split-pane -V --title Critic --size 0.5 -d %DIR% cmd.exe /k %CLAUDE% ; split-pane -H --title Optimist --size 0.5 -d %DIR% cmd.exe /k %CLAUDE% ; move-focus up ; split-pane -H --title Realist --size 0.5 -d %DIR% cmd.exe /k %CLAUDE% ; move-focus down ; move-focus down ; split-pane -H --title Wildcard --size 0.5 -d %DIR% cmd.exe /k %CLAUDE%'"
