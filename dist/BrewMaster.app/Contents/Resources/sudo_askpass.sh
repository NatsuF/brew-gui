#!/bin/bash
# SUDO_ASKPASS helper for BrewMaster
# Shows a native macOS password dialog when sudo needs a password.

exec osascript <<'APPLESCRIPT'
tell application "System Events"
    try
        set passResult to text returned of (display dialog "BrewMaster 需要管理员密码来继续操作" default answer "" with hidden answer with title "BrewMaster" buttons {"取消", "确定"} default button "确定")
        return passResult & linefeed
    on error
        return ""
    end try
end tell
APPLESCRIPT
