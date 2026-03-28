@echo off
REM CC2CC Demo Debate — 5-agent layout in Windows Terminal
REM
REM Layout:
REM ┌──────────┬──────────┐
REM │ Moderator│  Critic  │
REM ├──────────┼──────────┤
REM │ Optimist │ Realist  │
REM ├──────────┴──────────┤
REM │      Wildcard       │
REM └─────────────────────┘
REM
REM After launch: paste the persona prompt from docs/Demo.md into each pane,
REM then tell moderator to start the debate.

wt -M ^
  --title "Moderator" cmd /k "claude --dangerously-load-development-channels" ^
  ; split-pane -V --title "Critic" cmd /k "claude --dangerously-load-development-channels" ^
  ; split-pane -H --title "Optimist" --size 0.5 cmd /k "claude --dangerously-load-development-channels" ^
  ; move-focus left ^
  ; split-pane -H --title "Realist" --size 0.5 cmd /k "claude --dangerously-load-development-channels" ^
  ; split-pane -H --title "Wildcard" --size 0.33 cmd /k "claude --dangerously-load-development-channels"
