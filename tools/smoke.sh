#!/bin/sh
# UI smoke test in headless Chromium: rendering, focus, no JS errors.
# Run: make smoke  (needs the `serve` service up)
#
# CHROME and BASE can be overridden to run the same checks outside the
# container, e.g. against `make dev` with a local Chromium:
#   CHROME=chromium BASE=http://localhost:8080/index.html sh tools/smoke.sh
set -e

BASE=${BASE:-http://serve:8080/index.html}
CHROME=${CHROME:-chromium-browser}
ERR=/tmp/chrome.err
fail=0

# How much virtual time the page is given before the DOM is read. Headless runs
# it as fast as it can, so every timer inside the budget has already fired by the
# time anything is checked: four seconds is enough for everything the app does at
# startup (the app list of a desktop browser is a mock that answers at once).
BUDGET=4000

# Eight presses of ▼ walk the eight mock apps of one column down to the foot
# (the Home button, the third quick one); seven stop on the last app. One ▶ more
# is the Settings button beside Home.
DOWN7='down,down,down,down,down,down,down'
DOWN8="$DOWN7,down"
SETTINGS="$DOWN8,right"

run() { # run <query-string> -> page DOM in $DOM
  DOM=$("$CHROME" --no-sandbox --headless --disable-gpu \
        --enable-logging=stderr --v=0 --virtual-time-budget=$BUDGET \
        --dump-dom "$BASE?$1" 2>"$ERR")
}

check() { # check <pattern> <description>
  if printf '%s' "$DOM" | grep -q "$1"; then
    echo "  ok   $2"
  else
    echo "  FAIL $2  (missing: $1)"
    fail=1
  fi
}

absent() { # absent <pattern> <description>
  if printf '%s' "$DOM" | grep -q "$1"; then
    echo "  FAIL $2  (unexpected: $1)"
    fail=1
  else
    echo "  ok   $2"
  fi
}

count() { # count <pattern> <expected> <description>
  n=$(printf '%s' "$DOM" | grep -o "$1" | wc -l | tr -d ' ')
  if [ "$n" = "$2" ]; then
    echo "  ok   $3"
  else
    echo "  FAIL $3  (expected $2 of $1, got $n)"
    fail=1
  fi
}

console_clean() {
  if grep -qiE 'uncaught|referenceerror|syntaxerror|typeerror' "$ERR"; then
    echo "  FAIL JS errors in console:"
    grep -iE 'uncaught|referenceerror|syntaxerror|typeerror' "$ERR" | head -5
    fail=1
  else
    echo "  ok   console has no JS errors"
  fi
}

echo "== dock opens on launch =="
# labels=10: the name balloon fades after Appearance -> Show hints (0.5 s by
# default), and the virtual time budget (4 s) would run past it.
run 'labels=10'
check 'id="dock" class="dock is-open"' 'dock is open right away'
absent 'class="menu is-open"' 'the Settings window stays closed'
check 'data-cols="1"' 'one column by default'
count 'role="option"' 8 'one tile per mock user app'
check 'class="dock__tile is-focused" role="option" data-index="0"' 'focus starts on the first app'
absent 'dock__label is-on' 'no name until an arrow or the pointer moves the focus'
check 'class="dock__tile dock__tile--settings"' 'the Settings button is there, not focused'
check 'dock__gear"><svg' 'the button carries its icon'
console_clean

echo "== the pointer when the dock is shown =="
# A dock shown with no pointer on the screen (called by a key, HOME) keeps the pointer from
# moving the focus until it is moved; one shown with the pointer on the screen (called by the
# Magic Remote, ?cursor=on) behaves as it always did. With HOME bound to the dock (?homeBound=1)
# a pointer that the TV shows right after the showing (?cursorShow=1, what it does when HOME
# calls the dock) is put away: an arrow is sent through the paired TV — a browser has no
# bridge, so the try ends as "failed", which is the outcome the page records.
run ''
check 'data-pointer="guard"' 'no pointer on the screen: a hover moves no focus'
check 'data-cursor-hide="skipped"' 'HOME is not bound: nothing is put away'
run 'cursor=on'
check 'data-pointer="free"' 'the pointer is already there: nothing changes'
run 'homeBound=1'
check 'data-cursor-hide="armed"' 'HOME bound and no pointer yet: ready to put it away'
run 'homeBound=1&cursorShow=1'
check 'data-cursor-hide="failed"' 'the pointer came by itself: one try to put it away (a browser cannot send the arrow)'
run 'homeBound=0&cursorShow=1'
check 'data-cursor-hide="skipped"' 'HOME not bound: the pointer that came is left alone'
run 'cursor=on&homeBound=1&cursorShow=1'
check 'data-cursor-hide="skipped"' 'the pointer was there before: a call by the pointer, nothing is put away'
run 'keys=down,down'
check 'data-pointer="guard"' 'the guard does not stand in the way of the arrows'
check 'class="dock__tile is-focused" role="option" data-index="2"' 'which move the focus as always'
console_clean

echo "== the clock =="
run ''
check 'id="dockClock" class="dock__clock" aria-hidden="true">[0-9][0-9]:[0-9][0-9]<' 'the time is above the icons (24h by default)'
check 'data-clock-accent="on"' 'in the accent colour by default'
check 'id="dockDate" class="dock__date" aria-hidden="true">[0-9]' 'the date is under the foot'
run 'time=off&date=off'
check 'data-clock="off"' 'Time format off takes the clock away'
check 'data-date="off"' 'Date format off takes the date away'
run 'time=12h'
check 'class="dock__clock" aria-hidden="true">[0-9]*:[0-9][0-9] [AP]M<' 'the 12-hour clock'
run 'time=24hn'
absent 'class="dock__clock" aria-hidden="true">0[0-9]:' 'the 24-hour clock without a zero before a single digit'
run 'date=dm'
check 'class="dock__date" aria-hidden="true">[0-9][0-9]\.[0-9][0-9]<' 'the date as day.month'
run 'date=dlong&lang=ru'
check 'class="dock__date" aria-hidden="true">[0-9]* [а-я]*<' 'the full name of the month, in the genitive in Russian'
run ''
check 'data-clock-size="m"' 'the clock is the middle size by default'
check 'data-date-size="m"' 'and so is the date'
run 'clockSize=xl&dateSize=xs'
check 'data-clock-size="xl"' 'the clock can be the largest size'
check 'data-date-size="xs"' 'and the date the smallest, each on its own'
# The row of a format starts with the option that shows nothing, and says so.
run 'section=clock&expand=appTimeFormat'
check 'data-id="appTimeFormat" data-value="off"' 'the Time format list has the empty choice'
check '>Empty<' 'and it reads Empty, not nothing'
run 'section=clock&expand=appClockSize'
count 'data-id="appClockSize" data-value=' 5 'five sizes of the clock: XS S M L XL'
console_clean

echo "== the name balloon =="
run 'labels=10&hints=1&keys=down'
check 'dock__label is-on[^>]*>' 'an arrow that moved the focus shows the name'
run 'labels=0&keys=down'
absent 'dock__label is-on' 'Show hints 0: no name'
run 'labels=1&keys=down'
absent 'dock__label is-on' 'the name fades once its seconds are up'
run 'labels=10&hints=1&keys=down,relaunch'
absent 'dock__label is-on' 'a dock brought back by Home draws no name'
# Beside the panel (Hint placement: Next to the dock): on the side of the picture, and on the
# other side of the panel when there is no room there (the dock at the far right with the
# largest offset and seven columns, as in the report: the picture side is the left one,
# 72 px wide).
run 'labelPlace=dock&labels=10&hints=1&keys=down'
check 'dock__label is-on dock__label--dock"' 'at the left edge the name is at the right of the panel'
run 'labelPlace=dock&side=right&labels=10&hints=1&keys=down'
check 'dock__label is-on dock__label--dock-left' 'at the right edge it is at the left of the panel'
run 'labelPlace=dock&cols=7&side=right&dockX=960&labels=10&hints=1&keys=down'
check 'dock__label is-on dock__label--dock"' 'with no room at the left it goes to the other side'
console_clean

echo "== which apps the dock shows =="
# The mock list carries one entry of every kind the dock must leave out.
run ''
absent 'com.webos.app.browser' 'system apps are left out'
absent 'org.example.hidden' 'hidden apps are left out'
absent 'data-id="webocu.dock"' 'the dock does not list itself'
check 'data-index="0" data-id="org.webosbrew.hbchannel"' 'sorted by name: Homebrew Channel first'
check 'data-index="7" data-id="org.example.video"' 'sorted by name: Web Video last'
console_clean

echo "== icons =="
run ''
check 'class="dock__img" alt="" src="icons/largeIcon.png"' 'a readable icon is shown as a picture'
check 'class="dock__letter"' 'an icon the browser cannot load falls back to a letter tile'
absent 'src="file://' 'no broken file:// picture is left behind'
console_clean

echo "== moving the focus =="
run 'labels=10&hints=1&keys=down,down'
check 'class="dock__tile is-focused" role="option" data-index="2"' '▼ ▼ moves two apps down'
check 'dock__label is-on[^>]*>Music<' 'the balloon follows the focus'
run 'keys=up'
check 'class="dock__tile is-focused" role="option" data-index="0"' '▲ on the first app stays there'
run "labels=10&hints=1&keys=$DOWN8"
check 'dock__tile--quick is-focused" data-slot="3"' 'past the last app is the foot, Home first'
check 'dock__label is-on[^>]*>webOS Home<' 'the balloon names the button'
run "labels=10&hints=1&keys=$SETTINGS"
check 'dock__tile--settings is-focused' '▶ from Home is the Settings button'
check 'dock__label is-on[^>]*>Settings<' 'the balloon names it too'
# Hint placement: Next to the icon (no longer the default, hence ?labelPlace=tile).
# The name stands against its tile (dock.js paintLabel), under it, wherever the dock is:
# at the far right with the largest offset the old placement beside the panel ran off the
# left edge of the screen. At the bottom edge, where no room is left under the foot, it goes over.
run 'labelPlace=tile&side=right&dockX=960&labels=10&hints=1&keys=down'
check 'dock__label is-on dock__label--tile"' 'at the far right the name is placed against the tile'
run "labelPlace=tile&rows=3&dockY=540&labels=10&hints=1&keys=$DOWN8"
check 'dock__label is-on dock__label--tile-up' 'with no room under the foot the name goes over the button'
run "keys=$SETTINGS,left"
check 'dock__tile--quick is-focused" data-slot="3"' '◀ goes back to Home'
run "keys=$DOWN8,up"
check 'class="dock__tile is-focused" role="option" data-index="7"' '▲ from the foot goes back to the last app'
console_clean

echo "== the foot =="
run ''
check 'id="dockQuick3" class="dock__tile dock__tile--quick" data-slot="3"' 'the third quick button is there, and drawn'
check 'aria-label="webOS Home"' 'by default it is Home'
check 'dock__tile--off" data-slot="1"' 'buttons 1 and 2 are empty by default'
run 'home=0'
check 'dock__tile--off" data-slot="3"' '?home=0 empties the third'
run "home=0&keys=$DOWN8"
check 'dock__tile--settings is-focused' 'without Home the foot is the Settings button'
BUDGET=1000
run "keys=$DOWN8,enter"
BUDGET=4000
# The launch balloon is replaced at once by the mock's answer in a browser.
check 'Dev mode: request not sent' 'OK on Home launches; nothing is sent from a browser'
console_clean

# The third quick button as Power Off / Restart: OK opens a countdown window with the
# action focused; at zero the action is called (a browser only mocks it), and
# ◀ to Cancel stops the count and leaves the plain question on screen. The short
# budget is the first second of the count, the long one is past its end.
run 'home=poweroff'
absent 'dock__tile--off" data-slot="3"' 'Power Off: the button is there'
check 'aria-label="Power Off"' 'and named by its action'
run 'home=restart'
check 'aria-label="Restart"' 'Restart: named by its action'
BUDGET=500
run "home=poweroff&keys=$DOWN8,enter"
check 'class="dialog is-open"' 'Power Off: OK opens the window'
check 'The TV will turn off in [0-9] s' 'which counts seconds down'
check 'dialog__btn dialog__btn--danger is-focused' 'with the action focused'
run "home=restart&keys=$DOWN8,enter"
check 'The TV will restart in [0-9] s' 'Restart counts down too'
BUDGET=8000
run "home=poweroff&keys=$DOWN8,enter"
check 'Dev mode: request not sent' 'at zero the action is called (mocked in a browser)'
absent 'class="dialog is-open"' 'and the window is gone'
run "home=poweroff&keys=$DOWN8,enter,left"
check 'class="dialog is-open"' '◀ to Cancel keeps the window open past zero'
check 'Turn off the TV?' 'with the plain question, no count'
BUDGET=4000
console_clean

echo "== rows, offsets =="
run 'rows=4'
check '\-\-rows: *4' 'four rows on screen'
absent 'dock__bar' 'the dock has no scroll bar'
absent 'data-scrollbar' 'and no switch for one'
run 'dockX=0'
check '\-\-dock-x: *0px' 'the dock can touch the left edge'
run 'dockX=960'
check '\-\-dock-x: *960px' 'or stand at the middle of the screen'
run 'side=right'
check 'data-side="right"' 'the dock can stand at the right edge'
run 'cols=2&dockY=-100'
check 'margin-top: -200px' 'a vertical shift moves the panel up'
run 'rows=7&dockY=540'
check 'id="dockPanel" class="dock__panel" style="[^"]*margin-top: [0-9]' 'a shift past the room is clamped to it'
absent 'margin-top: 1080px' 'and never pushes the panel off screen'
console_clean

echo "== hidden apps =="
run 'hide=org.example.music'
count 'role="option"' 7 '?hide= takes an app off the dock'
absent 'data-id="org.example.music"' 'the one asked for'
run 'hide=org.webosbrew.hbchannel,org.example.player,org.example.video,org.example.music,org.example.weather,org.example.news,org.example.photos,org.example.radio'
check 'dock__state--hidden' 'every app hidden shows the placeholder'
check 'All apps are hidden' 'and says where to bring them back'
console_clean

echo "== six rows, then it scrolls =="
run "keys=$DOWN7"
check 'class="dock__scroll" style="transform: translateY(-[1-9]' 'the seventh row scrolls into view'
run 'apps=30&keys=down,down,down,down,down,down,down,down,down,down'
count 'role="option"' 30 'thirty generated apps, thirty tiles'
check 'class="dock__scroll" style="transform: translateY(-[1-9]' 'a long list follows the focus'
console_clean

echo "== two columns =="
run 'cols=2'
check 'data-cols="2"' 'the column count is on <html>'
run 'cols=2&keys=right'
check 'class="dock__tile is-focused" role="option" data-index="1"' '▶ moves to the second column'
run 'cols=2&keys=right,down'
check 'class="dock__tile is-focused" role="option" data-index="3"' '▼ steps a whole row'
run 'cols=2&keys=down,down,down,down'
check 'dock__tile--quick is-focused" data-slot="3"' 'below the first column is Home'
run 'cols=2&keys=right,down,down,down,down'
check 'dock__tile--settings is-focused' 'below the second column is the Settings button'
absent 'class="dock__scroll" style="transform: translateY(-[1-9]' 'eight apps in two columns fit without scrolling'
console_clean

# Three and four columns: the foot is the same two small buttons at the right edge
# (CSS, looked at in the shots), picked by column — the left of two buttons under the first half
# of the columns (the middle of three goes with it), Settings under the rest — and
# ▲ goes back to the column the focus left, not to an edge. Eight apps: two rows
# of four, or three of three with a short last row.
# The quick buttons (Appearance -> Quick launch): buttons 1 and 2 are not drawn
# with one column even when set, from two columns up all four are, left to right,
# and an empty one takes no room. Eight apps in two columns are four rows, so four
# presses of ▼ from the first column reach the foot over its first button.
echo "== quick buttons =="
run 'q1=browser&q2=store'
check 'dock__tile--off" data-slot="1"' 'one column: button 1 is not drawn'
check 'dock__tile--off" data-slot="2"' 'nor is button 2'
run 'cols=2&q1=browser&q2=store'
absent 'dock__tile--off" data-slot="1"' 'two columns: button 1 is drawn'
check 'aria-label="Browser"' 'named by its command'
check 'aria-label="LG Store"' 'so is the second'
run 'cols=2&q1=browser&q2=store&keys=down,down,down,down'
check 'dock__tile--quick is-focused" data-slot="1"' 'below the first column is the first button'
run 'cols=2&q1=browser&q2=store&keys=down,down,down,down,right,right,right'
check 'dock__tile--settings is-focused' '▶ walks the four buttons to Settings'
run 'cols=2&q1=browser&q2=store&keys=down,down,down,down,up'
check 'class="dock__tile is-focused" role="option" data-index="6"' '▲ from the first button goes back to the first column'
run 'cols=2&q1=media&q3=homehub&labels=10&hints=1&keys=down,down,down,down'
check 'dock__label is-on[^>]*>Media Player<' 'the balloon names the command'
console_clean

echo "== submenu =="
run 'cols=2&q1=submenu&sub=poweroff,restart,screenoff&keys=down,down,down,down,enter'
check 'class="dock__sub is-on"' 'OK on the Submenu button opens its column'
count 'dock__tile dock__tile--sub' 4 'of the three items that are set and the dock Settings kept with them'
run 'cols=2&q1=submenu&sub=poweroff&keys=down,down,down,down,enter'
check 'class="dock__sub is-on"' 'a single item is enough for it to open'
run 'cols=2&q1=submenu&sub=off&keys=down,down,down,down,enter'
check 'class="dock__sub is-on"' 'with every place empty the column still opens'
count 'dock__tile dock__tile--sub' 1 'holding the dock Settings only, so it is never a lock-out'
run 'cols=2&q1=submenu&sub=poweroff,restart,screenoff,home,media,home,store,browser&keys=down,down,down,down,enter'
count 'dock__tile dock__tile--sub' 8 'eight places without Settings stay eight: the eighth is replaced by it'
# Nothing stored: the places hold the defaults, the dock Settings first so the focus
# starts on the way into the window, then the TV's Settings and the screen switch.
run 'cols=2&q1=submenu&keys=down,down,down,down,enter'
count 'dock__tile dock__tile--sub' 3 'a fresh install has three items in the column'
check 'dock__tile--sub[^>]*aria-label="Settings"' 'the dock Settings is one of them'
check 'dock__tile--sub[^>]*aria-label="webOS Settings"' 'and the Settings of the TV, a command of its own'
check 'dock__tile--sub[^>]*aria-label="Screen Off"' 'and the screen switch'
absent 'dock__tile--sub[^>]*aria-label="Power Off"' 'Power Off is a choice, no longer a default'
run 'cols=2&q1=syssettings'
check 'aria-label="webOS Settings"' 'the TV Settings can also be a quick button'
# The hotkey screens of the TV (com.webos.app.tvhotkey, told which one by params.activateType)
# are two commands of their own: Eco mode and Sleep timer, on a quick button and in the column.
run 'cols=2&q1=eco&q2=sleep'
check 'aria-label="Eco mode"' 'Eco mode can be a quick button'
check 'aria-label="Sleep timer"' 'and so can the Sleep timer'
run 'cols=2&q1=eco&keys=down,down,down,down,enter'
check 'Dev mode: request not sent' 'OK on it starts the app (a browser sends nothing and says so)'
run 'cols=2&q1=submenu&sub=eco,sleep&keys=down,down,down,down,enter'
check 'dock__tile--sub[^>]*aria-label="Eco mode"' 'Eco mode is an item of the column'
check 'dock__tile--sub[^>]*aria-label="Sleep timer"' 'and so is the Sleep timer'
# Home pressed again while the dock is up (webOSRelaunch): the column goes away and the
# focus is on the button that opened it, not on an item of the column.
run 'cols=2&q1=submenu&keys=down,down,down,down,enter,down,relaunch'
absent 'class="dock__sub is-on"' 'a relaunch hides the open submenu'
check 'dock__tile--quick is-focused" data-slot="1"' 'and the focus stays on the quick button'
absent 'dock__tile--sub is-focused' 'no item of the column keeps it'
run "q4=submenu&keys=$SETTINGS,enter,down,relaunch"
absent 'class="dock__sub is-on"' 'the same for the Submenu on the fourth button'
check 'dock__tile--settings is-focused' 'with the focus on that button'
console_clean

echo "== button 4: Settings or the Submenu =="
run 'dockX=0'
check 'id="dockSettings"[^>]*aria-label="Settings"' 'by default the fourth button is Settings'
run "q4=submenu&keys=$SETTINGS,enter"
check 'id="dockSettings"[^>]*aria-label="Submenu"' 'set to Submenu it is named so'
check 'class="dock__sub is-on"' 'and OK on it opens the column'
run "q4=submenu&sub=off&keys=$SETTINGS,enter"
check 'class="dock__sub is-on"' 'with every place empty it opens the column of Settings'
run 'section=quick'
check 'data-id="dockQuick4"' 'the row of button 4 is in Quick launch'
console_clean

echo "== hints: their own level =="
run 'section=hints'
for id in dockHintsApps dockHintsQuick dockHintsSub dockLabels dockLabelPlace dockLabelStyle dockLabelEffect dockLabelText dockLabelBorder; do
  check "data-id=\"$id\"" "row $id is on the Hints level"
done
run ''
check 'data-hint-style="pill"' 'the name is a capsule by default'
check 'data-hint-effect="slide"' 'it slides in by default'
check 'data-hint-text="off"' 'in the text colour'
check 'data-hint-border="off"' 'with the plain frame'
run 'hintStyle=solid&hintEffect=pop&hintText=1&hintBorder=1'
check 'data-hint-style="solid"' 'a style can be previewed'
check 'data-hint-effect="pop"' 'and an effect'
check 'data-hint-text="on"' 'and the accent letters'
check 'data-hint-border="on"' 'and the accent frame'
run 'hints=0&labels=10&keys=down'
absent 'dock__label is-on' 'with the names switched off an arrow shows none'
run 'hints=1&labels=10&keys=down'
check 'dock__label is-on' 'and with them on it does'
# One switch for each kind of tile: the apps of the list, the quick buttons of the foot,
# the items of the submenu. In a fresh install only the submenu names itself, and each
# switch is independent of the other two (hints=0 puts all three off, a kind is then
# switched on by itself).
run 'labels=10&keys=down'
absent 'dock__label is-on' 'by default an app shows no name'
run "labels=10&keys=$DOWN8"
absent 'dock__label is-on' 'by default a quick button shows none either'
run 'cols=2&q1=submenu&labels=10&keys=down,down,down,down,enter,down'
check 'dock__label is-on' 'but by default an item of the submenu shows its name'
run 'hints=0&hintsApps=1&labels=10&keys=down'
check 'dock__label is-on' 'apps on: a name on an app'
run "hints=0&hintsApps=1&labels=10&keys=$DOWN8"
absent 'dock__label is-on' 'but not on a quick button'
run "hints=0&hintsQuick=1&labels=10&keys=$DOWN8"
check 'dock__label is-on' 'quick on: a name on a quick button'
run 'hints=0&hintsQuick=1&labels=10&keys=down'
absent 'dock__label is-on' 'but not on an app'
run 'hintsSub=0&cols=2&q1=submenu&labels=10&keys=down,down,down,down,enter,down'
absent 'dock__label is-on' 'submenu off: no name on an item'
run 'section=hints&expand=dockLabels'
count 'data-id="dockLabels" data-value=' 4 'four timings: 0.5 1 3 5'
absent 'data-id="dockLabels" data-value="0"' 'and no 0: the switch is the way to turn the names off'
run 'section=hints&expand=dockLabelStyle'
count 'data-id="dockLabelStyle" data-value=' 5 'five styles'
run 'section=hints&expand=dockLabelEffect'
count 'data-id="dockLabelEffect" data-value=' 4 'four effects'
console_clean

echo "== three to seven columns =="
run 'cols=4'
check 'data-cols="4"' 'four columns are on <html>'
run 'cols=3'
check 'data-cols="3"' 'so are three'
run 'cols=4&keys=right,down,down'
check 'dock__tile--quick is-focused" data-slot="3"' 'four columns: below the second column is Home'
run 'cols=4&keys=right,right,down,down'
check 'dock__tile--settings is-focused' 'below the third is Settings'
run 'cols=4&keys=right,down,down,up'
check 'class="dock__tile is-focused" role="option" data-index="5"' '▲ from Home goes back to the column it left'
run 'cols=4&keys=right,right,right,down,down,up'
check 'class="dock__tile is-focused" role="option" data-index="7"' '▲ from Settings goes back to its column too'
run 'cols=4&keys=right,down,down,right,up'
check 'class="dock__tile is-focused" role="option" data-index="7"' '▲ after ▶ to Settings goes to its edge column'
run 'cols=3&keys=right,right,down,down,down'
check 'dock__tile--quick is-focused" data-slot="3"' 'three columns: the middle one goes with Home'
run 'cols=3&keys=right,right,down,down,down,right'
check 'dock__tile--settings is-focused' 'and ▶ reaches Settings'
run 'cols=4&home=0&keys=down,down'
check 'dock__tile--settings is-focused' 'without the other button Settings is under every column'
# Seven columns, the most: fourteen apps make two full rows, so the column the
# focus leaves for the foot is the one it was in (the first four go with Home).
run 'cols=7'
check 'data-cols="7"' 'seven columns are on <html>'
run 'cols=7&apps=14&keys=right,right,right,down,down'
check 'dock__tile--quick is-focused" data-slot="3"' 'seven columns: below the fourth column is Home'
run 'cols=7&apps=14&keys=right,right,right,right,down,down'
check 'dock__tile--settings is-focused' 'below the fifth is Settings'
run 'cols=7&apps=14&keys=right,right,right,right,right,right,down,down,up'
check 'class="dock__tile is-focused" role="option" data-index="13"' '▲ from Settings goes back to the last column'
console_clean

echo "== launching in a browser =="
# Nothing is started outside a TV: the balloon says so and the dock stays.
# The balloon goes after two seconds, so the page gets less than that here.
BUDGET=1000
run 'keys=enter'
BUDGET=4000
check 'toast is-open' 'a balloon reports the launch'
check 'Dev mode: request not sent' 'the browser says nothing was sent'
check 'id="dock" class="dock is-open"' 'the dock is still there'
console_clean

echo "== no apps, and a failed read =="
run 'apps=0'
check 'dock__state--empty' 'an empty TV shows the placeholder'
check 'dock__note is-on[^>]*>No user apps are installed.<' 'and says why'
check 'dock__tile--settings is-focused' 'the Settings button is the focus'
run 'apps=fail'
check 'dock__state--failed' 'a failed read shows its own placeholder'
check 'The list of apps could not be read.' 'and says so'
check 'Settings → Tweaks → Request privileges' 'and points at the way to root by its row names'
console_clean

echo "== the Settings window =="
run "keys=$SETTINGS,enter"
check 'class="menu is-open"' 'OK on the button opens the window'
check 'id="dock" class="dock"' 'the dock steps aside meanwhile'
check 'rail__item is-active is-focused' 'focus starts on the rail of the window'
count 'role="tab"' 5 'five sections on the rail'
check 'rail__item rail__item--bottom' 'About is pinned to the foot of the rail'
check 'rail__head' 'the rail heading carries the icon'
run "keys=$SETTINGS,enter,back"
absent 'class="menu is-open"' 'Back on the rail closes the window'
check 'id="dock" class="dock is-open"' 'and brings the dock back'
check 'dock__tile--settings is-focused' 'with the focus where it was'
console_clean

echo "== general =="
# Where the focus stands when the dock is shown again (Home pressed while it is up:
# keys=...,relaunch): where it was left by default, else the first or the last app.
# Eight mock apps, so the last one is data-index="7".
run 'keys=down,down,relaunch'
check 'class="dock__tile is-focused" role="option" data-index="2"' 'focus on open: the last selected stays by default'
run 'openFocus=first&keys=down,down,relaunch'
check 'class="dock__tile is-focused" role="option" data-index="0"' 'focus on open: the first app'
run 'openFocus=end&keys=relaunch'
check 'class="dock__tile is-focused" role="option" data-index="7"' 'focus on open: the last app'
run 'openFocus=end&apps=30'
check 'class="dock__tile is-focused" role="option" data-index="29"' 'the dock opens on the last app of a long list'
run 'openFocus=first&keys=down,down'
check 'class="dock__tile is-focused" role="option" data-index="2"' 'and the user moves the focus from there as always'
console_clean

run 'section=common'
check 'General' 'section title'
check 'data-id="appLanguage"' 'the language row'
check 'data-id="appOpenAtStart"' 'the open-at-start row'
check 'data-id="appAutoHide"' 'the auto-hide row'
check 'data-id="appOpenFocus"' 'the focus-on-open row'
check 'data-id="appReset"' 'the reset row'
run 'boot=1&openAtStart=0'
check 'id="dock" class="dock" role="dialog" aria-modal="false" aria-label="Apps" aria-hidden="true"' 'a start by the TV with Autostart off leaves the dock hidden (a browser has no app to quit)'
run 'boot=1'
check 'id="dock" class="dock is-open"' 'and with it on, or a start by the user, the dock opens'
console_clean
run 'confirm=appReset'
check 'dialog is-open' 'reset asks first'
check 'Reset the settings of this app?' 'the question'
check 'dialog__btn is-focused' 'a button of the dialog has the focus'
absent 'dialog__btn dialog__btn--danger is-focused' 'and it is Cancel, not the destructive one'
console_clean

echo "== appearance =="
run 'section=look'
check 'Appearance' 'section title'
absent 'data-id="appLanguage"' 'the language lives in General'
# Six levels, in this order, the notifications last.
for id in lookTheme lookBg dockLayout dockHints dockQuick lookToast; do
  check "data-id=\"$id\"" "level $id"
done
absent 'data-id="appContrast"' 'the rows are on the levels, not on the page'
run 'section=theme'
for id in appDarkMode appContrast appAccent; do
  check "data-id=\"$id\"" "Theme: row $id"
done
check 'class="swatch"' 'the accent row carries its colour'
check 'data-theme="dark"' 'dark mode by default'
check 'data-contrast="off"' 'no contrast by default'
run 'section=bg'
for id in appBg appBgRail appTransparency; do
  check "data-id=\"$id\"" "Background: row $id"
done
run 'section=dock'
for id in dockColumns dockRows dockSide dockOffsetX dockOffsetY dockEffect; do
  check "data-id=\"$id\"" "Dock: row $id"
done
run 'section=toasts'
for id in appToastTop appToastAlign; do
  check "data-id=\"$id\"" "Notifications: row $id"
done
console_clean

echo "== how the dock comes onto the screen =="
# Seven entrances (Appearance -> Dock -> Entrance effect): out from behind the dock's own
# side by default, from the opposite side, from the top or the bottom, faded, grown, or at
# once. The panel says how far it stands from each edge, so the slides know how far to start.
run ''
check 'data-dock-effect="edge"' 'by default the dock comes out from behind its own edge'
check '\-\-panel-left: *[0-9]' 'the panel knows its distance from the left edge'
check '\-\-panel-right: *[0-9]' 'and from the right one'
check '\-\-panel-top: *[0-9]' 'and from the top'
check '\-\-panel-bottom: *[0-9]' 'and from the bottom'
for effect in opposite top bottom fade pop none; do
  run "dockEffect=$effect"
  check "data-dock-effect=\"$effect\"" "the $effect entrance can be previewed"
  check 'id="dock" class="dock is-open"' "and the dock is up with it"
done
run 'dockEffect=zoom'
check 'data-dock-effect="edge"' 'a name that is no entrance leaves the default'
run 'dockEffect=left'
check 'data-dock-effect="edge"' 'left and right are gone: the dock side and the opposite one took their place'
run 'expand=dockEffect'
count 'data-id="dockEffect" data-value=' 7 'seven entrances in the list'
run 'dockX=960&dockY=300&dockEffect=top'
check '\-\-panel-left: *[1-9]' 'far from the edge the distance is not zero'
console_clean

echo "== columns and rows are dropdowns =="
run 'expand=dockColumns'
check 'data-id="dockColumns" data-value="1"' 'one column is an option'
check 'data-id="dockColumns" data-value="2"' 'two columns'
check 'data-id="dockColumns" data-value="3"' 'three columns'
check 'data-id="dockColumns" data-value="4"' 'and four are the most'
absent 'data-id="dockColumns" data-value="5"' 'and there is no fifth'
run 'expand=dockRows'
check 'data-id="dockRows" data-value="3"' 'rows is a dropdown too: 3'
check 'data-id="dockRows" data-value="7"' 'up to 7'
absent 'data-id="dockRows" data-value="8"' 'and no 8'
console_clean

echo "== a dropdown opens in place =="
run 'section=common&expand=appLanguage'
check 'class="options" data-for="appLanguage"' 'the list stands under its row'
count 'class="option[ "]' 12 'with one option for each of the twelve languages'
# Six presses of down reach the Effect dropdown of the Hints level, the lowest of its
# rows that holds a list: it opens in place, deep in a level of nine rows.
run 'section=hints&keys=down,down,down,down,down,down,enter'
check 'class="options" data-for="dockLabelEffect"' 'a dropdown deep in a level opens'
console_clean

echo "== applications =="
run 'section=apps'
check 'Applications' 'section title'
check 'row--action[^"]*" data-id="appsHome"' 'the first row opens webOS Home (the way there when the foot button is not Home)'
check 'row--action[^"]*" data-id="appsRefresh"' 'a row to read the list again'
check 'data-id="appsPair"' 'without root, a row to pair the TV'
count 'data-id="appShow:' 8 'one reorder row per user app'
check 'class="row row--reorder[^"]*" data-id="appShow:org.webosbrew.hbchannel"' 'app rows are the reorder type'
absent 'appShow:com.webos.app.browser' 'no system apps'
absent 'appShow:org.example.hidden' 'no hidden apps'
# Into the rows (refresh, pair, then the first app), OK to pick it up, left to
# switch it off, then three Backs out of edit, rows and rail to the dock.
run 'section=apps&keys=down,down,enter,left,back,back,back'
count 'role="option"' 7 'the app switched off is gone from the dock'
absent 'data-id="org.webosbrew.hbchannel"' 'the one switched off'
console_clean

echo "== reordering apps =="
# The first app (Homebrew Channel) one place down: pick it up, press down (it swaps
# with Media Player), leave, and read the dock order.
run 'section=apps&keys=down,down,enter,down,back,back,back'
check 'data-index="0" data-id="org.example.player"' 'Media Player is first after the swap'
# The same step on the list itself: the held row swaps places with its neighbour in the
# DOM (no new list is written), is still held and focused, and a second step the other way
# puts the order back. A reorder row that is switched off is dimmed, and stays held.
run 'section=apps&keys=down,down,enter,down'
check 'data-id="appShow:org.example.player"[^>]*>.*data-id="appShow:org.webosbrew.hbchannel"' 'after one step down the first app stands after the second'
check 'row row--reorder is-focused is-editing" data-id="appShow:org.webosbrew.hbchannel"' 'and it is still the held row'
run 'section=apps&keys=down,down,enter,down,up'
check 'data-id="appShow:org.webosbrew.hbchannel"[^>]*>.*data-id="appShow:org.example.player"' 'a step back up puts the order back'
check 'row row--reorder is-focused is-editing" data-id="appShow:org.webosbrew.hbchannel"' 'the row is held through both steps'
run 'section=apps&keys=down,down,enter,left'
check 'row row--reorder row--off is-focused is-editing" data-id="appShow:org.webosbrew.hbchannel"' 'the switch flipped on the held row: dimmed, still held'
console_clean

echo "== TV inputs =="
# Read along with the apps, each a row of Applications of its own, off until
# switched on there.
run 'inputs=2'
count 'role="option"' 8 'inputs are off by default'
absent 'data-id="com.webos.app.hdmi1"' 'no HDMI tile until switched on'
run 'inputs=2&section=apps'
count 'data-id="appShow:' 10 'one row per app and per input'
check 'data-id="appShow:com.webos.app.hdmi1"' 'HDMI 1 has a row of its own'
console_clean

echo "== tweaks =="
run 'section=tweaks'
for id in requestPriv switchAppId tweaksKeepAlive homeHook homeSetting tweaksAppType; do
  check "data-id=\"$id\"" "row $id"
done
check 'HOME opens the dock (key hook)' 'the Home hook row is labelled'
absent 'data-id="appCursorFocus"' 'the old switch of the pointer is gone: it goes with the binding of HOME'
check 'Helper service' 'the state of the helper service is shown'
run 'section=switchAppId'
check 'WebOCU Dock ✓' 'the current app ID is marked in the list'
run 'section=keepalive'
check 'data-id="keepaliveSelfService"' 'keepalive: the service switch'
absent 'data-id="keepaliveInitScript"' 'keepalive: no switch for the init script, it is always on'
console_clean

echo "== about =="
run 'section=about'
check 'class="about"' 'about.html is read into the section'
check 'WebOCU' 'its text is there'
check 'Version' 'the version row is there'
absent 'data-id="appReset"' 'the reset moved to General'
console_clean

echo "== languages =="
run 'expand=appLanguage'
check 'Deutsch' 'languages listed under their own names'
check '简体中文' 'Chinese is listed too'
run 'lang=ru&section=look'
check 'Внешний вид' 'the window follows the language'
run "lang=ru&labels=10&hints=1&keys=$SETTINGS"
check 'dock__label is-on[^>]*>Настройки<' 'so does the dock'
console_clean

echo "== previews =="
run 'theme=light&contrast=1&accent=cyan'
check 'data-theme="light"' 'light mode'
check 'data-contrast="on"' 'contrast'
check '\-\-accent: *#00d5ff' 'accent colour on <html>'
run 'transparency=50'
check '\-\-ui-opacity: *0.5' 'transparency 50 leaves half of the opacity'
run 'transparency=100'
check '\-\-ui-opacity: *0.3' 'transparency has a ceiling (70)'
run ''
check '\-\-ui-opacity: *1' 'a fresh install is not transparent at all'
run 'bg=100&bgRail=0'
check 'data-bg="on"' 'picture behind the dock and the rows'
check 'data-bg-rail="off"' 'none behind the rail'
run 'toastAt=bottom-left'
check 'data-toast-v="bottom"' 'balloon at the bottom'
check 'data-toast-h="left"' 'balloon on the left'
console_clean

echo "== pending balloon =="
# A launch keeps this balloon up while the app manager works.
run 'toast=busy'
check 'toast is-open toast--busy\|toast--busy is-open' 'busy toast rendered with the spinner class'
check 'Starting Media Player' 'pending text shown'
console_clean

echo "== hidden =="
run 'panel=0'
check 'id="dock" class="dock" role="dialog" aria-modal="false" aria-label="Apps" aria-hidden="true"' 'dock hidden with ?panel=0'
absent 'class="menu is-open"' 'and no window instead'
console_clean

echo "== nothing of the settings panel is left =="
run ''
absent 'rail__clock' 'no clock band'
absent 'screen-cover' 'no screen-off cover'
run 'section=look'
absent 'row--reorder' 'no reorder rows'
absent 'Restart TV' 'no TV power rows'
absent 'Bluetooth' 'no bluetooth rows'
console_clean

if [ "$fail" -ne 0 ]; then
  echo "SMOKE: FAILED"
  exit 1
fi
echo "SMOKE: OK"
