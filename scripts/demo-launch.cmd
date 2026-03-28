@echo off
REM CC2CC Demo Debate — 5-agent layout in Windows Terminal
REM
REM Layout:
REM +-----------+----------+
REM | Moderator |  Critic  |
REM +-----------+----------+
REM | Optimist  | Realist  |
REM +-----------+----------+
REM |       Wildcard       |
REM +----------------------+
REM
REM After launch: paste the persona prompt from docs/Demo.md into each pane,
REM then tell moderator to start the debate.

set CLAUDE=claude --dangerously-skip-permissions --dangerously-load-development-channels server:cc2cc

powershell -NoProfile -Command "Start-Process wt -ArgumentList 'new-tab --title Moderator cmd.exe /k %CLAUDE% ; split-pane -V --title Critic cmd.exe /k %CLAUDE% ; split-pane -H --title Optimist cmd.exe /k %CLAUDE% ; move-focus left ; split-pane -H --title Realist cmd.exe /k %CLAUDE% ; split-pane -H --title Wildcard cmd.exe /k %CLAUDE%'"
