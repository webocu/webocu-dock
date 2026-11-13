# =============================================================================
#  WebOCU Dock - webOS TV
#  Everything runs in containers: docker is the only host requirement.
#
#  make            list the targets
#  make check      lint + smoke test + ipk build (full project check)
#  make dev        static server on http://localhost:8080
#  make tv-add TV=192.168.1.50
#  make deploy     package + install + launch on the TV
#  make inspect    Chrome DevTools (copy the URL from the output into Chrome)
#  Root for the helper service: in the app, Settings -> Tweaks -> Request privileges
#
#  Layout: source/ (app), tools/ (this toolchain), misc/ (readme assets),
#          dist/ (ipk), build/ + test/ (temporary, removed by make clean)
# =============================================================================

# =============================================================================
#  VERSION & BUILD WORKFLOW
#
#  Version Control:
#    make bump                        Bump patch version
#    make version-bump [PART=patch]   Explicitly bump version (patch/minor/major)
#
#  Build:
#    make build                       Build IPK package (idempotent, no version bump)
#    make build PART=patch            Build IPK and bump patch version
#
#  Deployment:
#    make bump                        Bump patch version first
#    make build                       Build IPK package
#    make deploy                      Install + launch existing IPK on TV
#
#  CI/Testing:
#    make check                       Validate without version changes (idempotent)
#
#  Cross-Platform Compatibility:
#    - All file operations use Docker containers for portability
#    - Auto-detects environment: cmd.exe on native Windows, bash everywhere else
#    - Works in: Windows cmd.exe, Git Bash, WSL, Linux, macOS
# =============================================================================

APP_ID     := webocu.dock
SERVICE_ID := webocu.dock.service

# Recursively expanded on purpose: `make package` bumps the patch number, and
# every later target must see the new value.
VERSION     = $(strip $(file < source/version.txt))
IPK         = dist/$(APP_ID)_$(VERSION)_all.ipk

# Docker Desktop puts both "docker" (a small wrapper with no shebang) and
# "docker.exe" on PATH. Make execs the binary itself for a plain recipe line and
# finds the .exe, but a line with quotes or an & in it goes through the shell,
# and a shell that does not append .exe picks the wrapper up instead - which
# cannot be exec'd ("exec format error: docker"). Naming the .exe on Windows
# makes both paths agree; elsewhere it stays plain docker.
DOCKER   := docker
ifeq ($(OS),Windows_NT)
DOCKER   := docker.exe
endif

# Explicit shell configuration for cross-platform compatibility
# Detect environment by checking for /bin/bash existence (works in Git Bash, WSL, native Unix)
ifneq ($(wildcard /bin/bash),)
  # Unix-like: Linux, macOS, Git Bash, WSL, Cygwin
  SHELL := /bin/bash
  BLANK_LINE = @echo
  Q := "
else
  # Native Windows cmd.exe
  SHELL := cmd.exe
  BLANK_LINE = @echo.
  Q :=
endif

# Help text is printed by make itself ($(info)), not by the shell, so it needs
# no quoting or ^-escaping and reads the same under bash and cmd.exe. I is the
# two-space indent: $(info) strips leading blanks, the empty E keeps them.
E :=
I := $(E)  $(E)

DC       := $(DOCKER) compose -f tools/docker-compose.yml
ARES     := $(DC) run --rm ares
DEVICE   ?=
NAME     ?=
TV       ?=
PORT     ?= 9922
USER     ?= prisoner
# Version bump part: major|minor|patch|keep (default: keep = no bump). The
# comment sits on its own line: written after the value, the blanks before it
# would become part of PART.
PART     ?= keep
# The window type in source/appinfo.json (make window): popup is the default,
# the rest exist to be compared against the system panels on a live TV.
TYPE     ?= popup

.DEFAULT_GOAL := help

# Suppress "Entering directory" / "Leaving directory" messages from recursive make calls
MAKEFLAGS += --no-print-directory

# Git Bash / msys rewrites container paths like /out/x.png into Windows ones on
# the way to docker.exe, and the screenshots go to a path inside the container.
# Exported rather than written in front of the command: an inline assignment in
# a recipe fails to exec under some msys shells (zsh: exec format error).
export MSYS_NO_PATHCONV = 1

# =============================================================================
# INFORMATION & HELP
# =============================================================================
.PHONY: help
help: ## List all available targets
	$(info =============================================================================)
	$(info $(I)WebOCU Dock ($(APP_ID) v$(VERSION)))
	$(info =============================================================================)
	$(info )
	$(info DEVELOPMENT)
	$(info $(I)dev              Start dev server on http://localhost:8080)
	$(info $(I)dev-stop         Stop the dev server)
	$(info $(I)shots            Screenshots of the UI into test/shots/)
	$(info )
	$(info QUALITY CHECKS)
	$(info $(I)check            Run all checks (CI-safe, no version bump))
	$(info $(I)lint             Validate JS, manifests, i18n, and version consistency)
	$(info $(I)smoke            UI smoke tests in headless Chromium)
	$(info )
	$(info BUILD)
	$(info $(I)build            Build IPK package)
	$(info $(I)bump             Bump patch version)
	$(info $(I)docker-build     Build Docker image with ares-* tools)
	$(info $(I)package          (Deprecated: use 'build'))
	$(info $(I)icons            Regenerate source/icons/*.png)
	$(info $(I)version          Print current version)
	$(info $(I)version-bump     Bump version manually (PART=major|minor|patch))
	$(info $(I)window           Switch window type for testing)
	$(info )
	$(info TV SETUP)
	$(info $(I)tv-add           Register Developer Mode TV (requires TV=<ip> NAME=<name>))
	$(info $(I)tv-add-root      Register rooted TV (requires TV=<ip> NAME=<name>))
	$(info $(I)tv-key           Fetch developer key (NAME=<name> optional))
	$(info $(I)tv-list          List registered devices)
	$(info $(I)tv-remove        Remove a registered device (requires NAME=<name>))
	$(info $(I)tv-reset         Reset all registered devices)
	$(info $(I)tv-use-tv        Switch to TV device)
	$(info $(I)tv-use-emulator  Switch to emulator device)
	$(info $(I)tv-use-<name>    Switch to any device (e.g. tv-use-tv2))
	$(info )
	$(info TV OPERATIONS)
	$(info $(I)install          Install IPK on registered TV (requires built IPK))
	$(info $(I)launch           Launch app on TV)
	$(info $(I)close            Close running app on TV)
	$(info $(I)inspect          Open Chrome DevTools for remote debugging)
	$(info $(I)deploy           Deploy existing IPK: install + launch (run 'make bump build' first))
	$(info $(I)uninstall        Remove app from TV)
	$(info )
	$(info UTILITIES)
	$(info $(I)shell            Bash inside ares-* container)
	$(info $(I)clean            Remove build/ and test/ directories)
	$(info $(I)distclean        Deep clean: remove dist/, containers, and images)
	$(info )
	$(info -----------------------------------------------------------------------------)
	$(info Variables:)
	$(info $(I)TV=<ip>          TV IP address (for tv-add, tv-add-root))
	$(info $(I)NAME=<name>      Device name (for tv-add, tv-add-root, tv-key, tv-remove))
	$(info $(I)DEVICE=$(DEVICE)   Target device for operations (default: from profile))
	$(info $(I)PORT=$(PORT)        SSH port for Developer Mode)
	$(info $(I)USER=$(USER)    SSH user (default: prisoner))
	$(info $(I)PART=$(PART)        Version part: major|minor|patch|keep (version-bump, build))
	$(info $(I)TYPE=$(TYPE)     Window type (overlay|minimal|popup|system_ui))
	$(info )
	$(info Rooted TV:)
	$(info $(I)ROOT_PORT=$(ROOT_PORT)     SSH port for root (default: 22))
	$(info $(I)ROOT_USER=$(ROOT_USER)   SSH user (default: root))
	$(info $(I)ROOT_PASS=$(ROOT_PASS) SSH password (default: alpine))
	@echo =============================================================================

# =============================================================================
# QUALITY CHECKS
# =============================================================================
.PHONY: check
check: lint smoke build-ipk ## Run all checks (full CI validation)

.PHONY: lint
lint: ## Validate JS, manifests, i18n, and version consistency
	$(DC) run --rm lint

.PHONY: smoke
smoke: ## UI smoke tests in headless Chromium
	$(DC) up -d serve
	$(DC) run --rm smoke

# =============================================================================
# BUILD
# =============================================================================
.PHONY: icons
icons: ## Regenerate source/icons/*.png
	$(DC) run --rm icons

.PHONY: docker-build
docker-build: ## Build Docker image with ares-* tools
	$(DC) build ares

.PHONY: build-ipk
build-ipk: docker-build ## Build IPK package (internal target)
	$(DC) run --rm -e PART=$(PART) ares sh tools/package.sh

.PHONY: build
build: build-ipk ## Build IPK package

.PHONY: package
package: build-ipk ## (Deprecated: use 'make build' instead)

.PHONY: version
version: ## Print current version
	@echo $(VERSION)

.PHONY: version-bump
version-bump: ## Bump version manually (PART=major|minor|patch)
	$(DC) run --rm icons sh tools/version.sh $(PART)

.PHONY: bump
bump: ## Bump patch version
	$(MAKE) version-bump PART=patch

.PHONY: window
window: ## Switch window type for testing (TYPE=overlay|popup|minimal|system_ui)
	$(DC) run --rm icons sh tools/window.sh $(TYPE)

# =============================================================================
# DEVELOPMENT
# =============================================================================
.PHONY: dev
dev: ## Start dev server on http://localhost:8080
	$(DC) up serve

.PHONY: dev-stop
dev-stop: ## Stop the dev server
	$(DC) down

SHOT_BASE := $(DC) run --rm shot --no-sandbox --headless --disable-gpu \
             --hide-scrollbars --window-size=1920,1080
SHOT      := $(SHOT_BASE) --virtual-time-budget=4000
# Virtual time runs as fast as it can, so a shot of something a timer takes away
# has to be taken before it fires: the balloon of a launch goes two seconds after
# it appeared, and four seconds of budget would photograph the dock without it.
SHOT_QUICK := $(SHOT_BASE) --virtual-time-budget=1000
# Eight presses of down walk the eight mock apps of one column to the foot of
# the dock: Home, the third quick button; one right more is Settings.
DOWN8     := down,down,down,down,down,down,down,down

.PHONY: shots
shots: ## Screenshots of the UI into test/shots/ (headless Chromium, no TV)
	$(DC) up -d serve
#	The dock as it opens: one column, the first app focused, and no name: the name shows
#	only after an arrow or the pointer moved the focus (the shots that show it have keys=).
#	labels=10&hints=1 on the shots that show the name: it fades after Show hints
#	(0.5 s by default), sooner than the four seconds of budget.
	$(SHOT) --screenshot=/out/01-dock.png "http://serve:8080/index.html?labels=10&hints=1"
#	A fresh install after an arrow: the apps and the quick buttons name nothing by default (only
#	the items of the submenu do), so the same step as the shots around it shows no name.
	$(SHOT) --screenshot=/out/01-dock-hints-default.png "http://serve:8080/index.html?labels=10&keys=down"
#	Hint placement Next to the icon (labelPlace=tile, the default is Next to the dock): the name against its tile at the far right with the largest offset and seven columns: the panel
#	stands at the middle of the screen, and the name used to be placed beside it, past the
#	left edge, so only its last letters showed. Now it is under the tile, on screen.
	$(SHOT) --screenshot=/out/01-dock-label-edge.png "http://serve:8080/index.html?labels=10&hints=1&labelPlace=tile&cols=7&side=right&dockX=960&keys=down"
#	The same dock with Hint placement set to Next to the dock: the picture side (left) has 72 px
#	only, so the name goes to the other side of the panel instead of running off the screen.
	$(SHOT) --screenshot=/out/01-dock-label-edge-dock.png "http://serve:8080/index.html?labels=10&hints=1&labelPlace=dock&cols=7&side=right&dockX=960&keys=down"
#	The grid of the apps, columns x rows (Appearance -> Dock): 1, 2, 3, 4 and 7 columns at
#	the fewest and the most rows (3 and 7). Sixty apps fill every cell of the biggest grid
#	(7x7 is 49), so the panel is as big as the setting makes it: 1x3 is the smallest panel,
#	7x7 the largest (the foot stays two small buttons at its right edge). The focus
#	moved across and down a row (on one column the right arrow has nowhere to go).
	$(SHOT) --screenshot=/out/02-grid-1x3.png "http://serve:8080/index.html?labels=10&hints=1&apps=60&cols=1&rows=3&keys=right,down"
	$(SHOT) --screenshot=/out/02-grid-1x7.png "http://serve:8080/index.html?labels=10&hints=1&apps=60&cols=1&rows=7&keys=right,down"
	$(SHOT) --screenshot=/out/02-grid-2x3.png "http://serve:8080/index.html?labels=10&hints=1&apps=60&cols=2&rows=3&keys=right,down"
	$(SHOT) --screenshot=/out/02-grid-2x7.png "http://serve:8080/index.html?labels=10&hints=1&apps=60&cols=2&rows=7&keys=right,down"
	$(SHOT) --screenshot=/out/02-grid-3x3.png "http://serve:8080/index.html?labels=10&hints=1&apps=60&cols=3&rows=3&keys=right,down"
	$(SHOT) --screenshot=/out/02-grid-3x7.png "http://serve:8080/index.html?labels=10&hints=1&apps=60&cols=3&rows=7&keys=right,down"
	$(SHOT) --screenshot=/out/02-grid-4x3.png "http://serve:8080/index.html?labels=10&hints=1&apps=60&cols=4&rows=3&keys=right,down"
	$(SHOT) --screenshot=/out/02-grid-4x7.png "http://serve:8080/index.html?labels=10&hints=1&apps=60&cols=4&rows=7&keys=right,down"
	$(SHOT) --screenshot=/out/02-grid-7x3.png "http://serve:8080/index.html?labels=10&hints=1&apps=60&cols=7&rows=3&keys=right,down"
	$(SHOT) --screenshot=/out/02-grid-7x7.png "http://serve:8080/index.html?labels=10&hints=1&apps=60&cols=7&rows=7&keys=right,down"
#	The foot: Home focused, then the Settings button OK opens the window from.
	$(SHOT) --screenshot=/out/03-dock-home.png "http://serve:8080/index.html?labels=10&hints=1&keys=$(DOWN8)"
	$(SHOT) --screenshot=/out/03-dock-button.png "http://serve:8080/index.html?labels=10&hints=1&keys=$(DOWN8),right"
#	Two columns: the two small foot buttons at the right edge of the panel.
	$(SHOT) --screenshot=/out/03-dock-foot-cols.png "http://serve:8080/index.html?labels=10&hints=1&cols=2&keys=right,down,down,down,down"
#	Four columns: a wide panel, the foot still two small buttons at
#	its right edge (the left one focused), as with every other number of columns.
	$(SHOT) --screenshot=/out/03-dock-foot-cols4.png "http://serve:8080/index.html?labels=10&hints=1&cols=4&keys=right,down,down"
#	Eco mode (the leaf) and the Sleep timer on the first two quick buttons: the hotkey screens of
#	the TV, started through com.webos.app.tvhotkey with params.activateType.
	$(SHOT) --screenshot=/out/03-dock-quick-eco.png "http://serve:8080/index.html?labels=10&hints=1&cols=2&q1=eco&q2=sleep&keys=down,down,down,down"
#	All four buttons of the foot, which take the width of two columns exactly
#	(Appearance -> Quick launch; the first of them focused).
	$(SHOT) --screenshot=/out/03-dock-quick.png "http://serve:8080/index.html?labels=10&hints=1&cols=2&q1=store&q2=browser&keys=down,down,down,down"
#	The Submenu quick button opened (button 1, focus on the first, top item, the name
#	beside the column): one column of the three default items (Settings, webOS
#	Settings, Screen Off), the size of the foot's icons, its bottom edge level with
#	the button that opened it.
	$(SHOT) --screenshot=/out/03-dock-submenu.png "http://serve:8080/index.html?labels=10&hints=1&cols=2&q1=submenu&keys=down,down,down,down,enter"
#	The most the submenu holds: eight items, 518px of column, still along the panel
#	(six were 394px); the focus walks to the last one.
	$(SHOT) --screenshot=/out/03-dock-submenu-8.png "http://serve:8080/index.html?labels=10&hints=1&cols=2&q1=submenu&sub=poweroff,restart,screenoff,home,syssettings,media,store,settings&keys=down,down,down,down,enter,down,down,down,down,down,down,down"
#	A short one: three items.
	$(SHOT) --screenshot=/out/03-dock-submenu-3.png "http://serve:8080/index.html?labels=10&hints=1&cols=2&q1=submenu&sub=poweroff,restart,screenoff&keys=down,down,down,down,enter"
#	Home pressed again while the submenu is up (keys=...,relaunch is the webOSRelaunch the TV
#	sends): the column is gone and the focus is on the quick button that opened it.
	$(SHOT) --screenshot=/out/03-dock-submenu-relaunch.png "http://serve:8080/index.html?labels=10&hints=1&cols=2&q1=submenu&keys=down,down,down,down,enter,down,relaunch"
#	Button 4 set to Submenu (?q4=submenu; Settings is the default): the column opens
#	beside it, one column of the dock, so the foot holds Home and the submenu button.
	$(SHOT) --screenshot=/out/03-dock-submenu-b4.png "http://serve:8080/index.html?labels=10&hints=1&q4=submenu&keys=$(DOWN8),right,enter"
#	Every place empty (?sub=off): the column still opens, holding the dock's Settings only,
#	because with Submenu on a button that item is the one way into the Settings window.
	$(SHOT) --screenshot=/out/03-dock-submenu-empty.png "http://serve:8080/index.html?labels=10&hints=1&cols=2&q1=submenu&sub=off&keys=down,down,down,down,enter"
#	Edges of the screen. At the bottom edge (the dock at its lowest, three rows, the
#	shortest panel) the column is still inside the panel's height and on screen:
	$(SHOT) --screenshot=/out/03-dock-submenu-bottom.png "http://serve:8080/index.html?labels=10&hints=1&rows=3&dockY=540&sub=poweroff,restart,screenoff,home,media,settings&q3=submenu&keys=$(DOWN8),enter"
#	and at the top edge.
	$(SHOT) --screenshot=/out/03-dock-submenu-top.png "http://serve:8080/index.html?labels=10&hints=1&rows=3&dockY=-540&sub=poweroff,restart,screenoff,home,media,settings&q3=submenu&keys=$(DOWN8),enter"
#	A seven-column dock far from its edge leaves no room beside it on the side of the
#	picture: the column goes to the other side of the dock, never over it.
	$(SHOT) --screenshot=/out/03-dock-submenu-flip.png "http://serve:8080/index.html?labels=10&hints=1&cols=7&dockX=960&q3=submenu&keys=$(DOWN8),enter"
#	The submenu follows the dock: at the right edge and shifted up it still stands
#	beside its button, on the side of the picture.
	$(SHOT) --screenshot=/out/03-dock-submenu-right.png "http://serve:8080/index.html?labels=10&hints=1&side=right&dockY=-200&q3=submenu&keys=$(DOWN8),enter"
#	Four columns without the third quick button: Settings alone, small, at the right edge.
	$(SHOT) --screenshot=/out/03-dock-foot-cols4-no-home.png "http://serve:8080/index.html?labels=10&hints=1&cols=4&home=0&keys=down,down"
#	The tallest dock: seven rows in two columns with the clock and the date, which
#	would be taller than the screen; the tiles of this panel give up the excess.
	$(SHOT) --screenshot=/out/03-dock-clock.png "http://serve:8080/index.html?labels=10&hints=1&cols=2&rows=7&apps=30"
#	The largest clock and date (XL), the widest of the formats: the panel grows by a few
#	pixels, the tiles give up what is over (fitPanel), and in one column the long date is cut
#	at the edge of the panel rather than widening it.
	$(SHOT) --screenshot=/out/03-dock-clock-xl.png "http://serve:8080/index.html?clockSize=xl&dateSize=xl&date=wdaydm&rows=7&apps=30"
#	The five styles of the name (Appearance -> Hints -> Style), each on the focused tile,
#	and the two colour switches on top of the capsule (the Solid style is filled with the
#	accent already and takes neither). Shot on one apps list so the styles can be compared.
	$(SHOT) --screenshot=/out/01-hint-pill.png "http://serve:8080/index.html?labels=10&hints=1&hintStyle=pill&keys=down"
	$(SHOT) --screenshot=/out/01-hint-soft.png "http://serve:8080/index.html?labels=10&hints=1&hintStyle=soft&keys=down"
	$(SHOT) --screenshot=/out/01-hint-solid.png "http://serve:8080/index.html?labels=10&hints=1&hintStyle=solid&keys=down"
	$(SHOT) --screenshot=/out/01-hint-text.png "http://serve:8080/index.html?labels=10&hints=1&hintStyle=text&keys=down"
	$(SHOT) --screenshot=/out/01-hint-compact.png "http://serve:8080/index.html?labels=10&hints=1&hintStyle=compact&keys=down"
	$(SHOT) --screenshot=/out/01-hint-colours.png "http://serve:8080/index.html?labels=10&hints=1&hintText=1&hintBorder=1&keys=down"
#	The Hints level of the window itself.
	$(SHOT) --screenshot=/out/08-hints.png "http://serve:8080/index.html?section=hints"
#	Focus on open set to the last app (?openFocus=end) with a list longer than the rows on screen:
#	the dock opens scrolled to the last icon, which has the focus.
	$(SHOT) --screenshot=/out/01-dock-open-end.png "http://serve:8080/index.html?labels=10&hints=1&openFocus=end&apps=30"
#	Without Home (?home=0 empties the third quick button): Settings alone, small.
	$(SHOT) --screenshot=/out/03-dock-no-home.png "http://serve:8080/index.html?home=0"
#	A list longer than six rows, scrolled with the focus (the list has no scroll bar).
	$(SHOT) --screenshot=/out/04-dock-scroll.png "http://serve:8080/index.html?labels=10&hints=1&apps=30&keys=$(DOWN8),down,down"
#	No user apps, and a list that could not be read: the placeholder and its note.
	$(SHOT) --screenshot=/out/05-dock-empty.png "http://serve:8080/index.html?apps=0"
	$(SHOT) --screenshot=/out/06-dock-failed.png "http://serve:8080/index.html?apps=fail"
#	A launch in a browser: nothing is sent, and the balloon says so.
	$(SHOT_QUICK) --screenshot=/out/07-dock-launch.png "http://serve:8080/index.html?keys=enter"
#	Where the dock stands (Appearance -> Dock): top, middle and bottom of the screen (dockY
#	-540, 0, 540) at the left and at the right edge (side). Three rows, the shortest panel,
#	so the vertical shift shows; the name balloon stands on the picture side of the panel,
#	to the left of it at the right edge.
	$(SHOT) --screenshot=/out/04-pos-top-left.png "http://serve:8080/index.html?labels=10&hints=1&rows=3&cols=2&dockY=-540&keys=down"
	$(SHOT) --screenshot=/out/04-pos-mid-left.png "http://serve:8080/index.html?labels=10&hints=1&rows=3&cols=2&dockY=0&keys=down"
	$(SHOT) --screenshot=/out/04-pos-bottom-left.png "http://serve:8080/index.html?labels=10&hints=1&rows=3&cols=2&dockY=540&keys=down"
	$(SHOT) --screenshot=/out/04-pos-top-right.png "http://serve:8080/index.html?labels=10&hints=1&rows=3&cols=2&side=right&dockY=-540&keys=down"
	$(SHOT) --screenshot=/out/04-pos-mid-right.png "http://serve:8080/index.html?labels=10&hints=1&rows=3&cols=2&side=right&dockY=0&keys=down"
	$(SHOT) --screenshot=/out/04-pos-bottom-right.png "http://serve:8080/index.html?labels=10&hints=1&rows=3&cols=2&side=right&dockY=540&keys=down"
#	The most rows pushed past the bottom: the shift is clamped, the panel stays whole;
#	and the middle of the screen across (dockX).
	$(SHOT) --screenshot=/out/04-dock-bottom.png "http://serve:8080/index.html?rows=7&dockY=540"
	$(SHOT) --screenshot=/out/04-dock-middle.png "http://serve:8080/index.html?dockX=960&cols=2"
#	Two apps taken off the dock (Settings -> Applications, previewed).
	$(SHOT) --screenshot=/out/04-dock-hidden.png "http://serve:8080/index.html?hide=org.example.music,org.example.news"
#	The Settings window, every row of every section but About. The window shows about five
#	rows, so a section longer than that has a second shot with the focus walked to its last
#	row (the list scrolls with the focus): General ends on Reset, Appearance on Notifications,
#	Applications on the last app of the list, Tweaks on Application type (five presses
#	from the top pass Request privileges, Switch app ID and Keep Alive). Appearance
#	is also shot as its levels (the list of them, then Theme, Background, Dock with the
#	column list open).
	$(SHOT) --screenshot=/out/08-common.png "http://serve:8080/index.html?section=common"
	$(SHOT) --screenshot=/out/08-common-2.png "http://serve:8080/index.html?section=common&keys=down,down,down,down,down"
	$(SHOT) --screenshot=/out/08-look.png   "http://serve:8080/index.html?section=look"
	$(SHOT) --screenshot=/out/08-look-2.png "http://serve:8080/index.html?section=look&keys=down,down,down,down,down"
	$(SHOT) --screenshot=/out/08-look-theme.png "http://serve:8080/index.html?section=theme"
	$(SHOT) --screenshot=/out/08-look-bg.png "http://serve:8080/index.html?section=bg"
	$(SHOT) --screenshot=/out/09-dock.png   "http://serve:8080/index.html?expand=dockColumns"
#	The list of entrances of the dock (Appearance -> Dock -> Entrance effect). The entrance
#	itself is a movement of a quarter of a second, over before a headless shot is taken: the
#	list is what a still picture can show.
	$(SHOT) --screenshot=/out/09-dock-effect.png "http://serve:8080/index.html?expand=dockEffect"
	$(SHOT) --screenshot=/out/09-apps.png   "http://serve:8080/index.html?section=apps"
	$(SHOT) --screenshot=/out/09-apps-2.png "http://serve:8080/index.html?section=apps&keys=down,down,down,down,down,down,down,down,down,down"
	$(SHOT) --screenshot=/out/10-tweaks.png "http://serve:8080/index.html?section=tweaks"
	$(SHOT) --screenshot=/out/10-tweaks-2.png "http://serve:8080/index.html?section=tweaks&keys=down,down,down,down,down"
	$(SHOT) --screenshot=/out/11-about.png  "http://serve:8080/index.html?section=about"
#	The rest of the levels, so that every screen of the window has a shot (the levels of
#	Appearance and of Tweaks; ?section= takes a level's id as well as a section's). A level
#	longer than the window gets a second shot with the focus on its last row, as above:
#	Dock (six rows), Clock and date (seven), Hints (nine: the first screen is 08-hints),
#	Quick launch (four buttons, then the eight submenu items: the focus on Item 3 puts
#	Button 3 at the top and the last on screen, Item 8 ends the list). Switch app ID and
#	Keep Alive are one screen each; Theme, Background and Notifications are above.
	$(SHOT) --screenshot=/out/08-hints-2.png "http://serve:8080/index.html?section=hints&keys=down,down,down,down,down,down,down,down"
	$(SHOT) --screenshot=/out/08-look-dock.png "http://serve:8080/index.html?section=dock"
	$(SHOT) --screenshot=/out/08-look-dock-2.png "http://serve:8080/index.html?section=dock&keys=down,down,down,down,down"
	$(SHOT) --screenshot=/out/08-look-clock.png "http://serve:8080/index.html?section=clock"
	$(SHOT) --screenshot=/out/08-look-clock-2.png "http://serve:8080/index.html?section=clock&keys=down,down,down,down,down,down"
	$(SHOT) --screenshot=/out/08-look-toasts.png "http://serve:8080/index.html?section=toasts"
	$(SHOT) --screenshot=/out/08-look-quick.png "http://serve:8080/index.html?section=quick"
	$(SHOT) --screenshot=/out/08-look-quick-2.png "http://serve:8080/index.html?section=quick&keys=down,down,down,down,down,down"
	$(SHOT) --screenshot=/out/08-look-quick-3.png "http://serve:8080/index.html?section=quick&keys=down,down,down,down,down,down,down,down,down,down,down,down"
	$(SHOT) --screenshot=/out/10-tweaks-appid.png "http://serve:8080/index.html?section=switchAppId"
	$(SHOT) --screenshot=/out/10-tweaks-keepalive.png "http://serve:8080/index.html?section=keepalive"
#	The confirmation of the reset, Cancel focused.
	$(SHOT) --screenshot=/out/12-confirm.png "http://serve:8080/index.html?confirm=appReset"
#	The accent list with its swatches.
	$(SHOT) --screenshot=/out/13-accents.png "http://serve:8080/index.html?expand=appAccent"
#	A dropdown opened far down a level (Effect, the lowest list of the Hints level): the row and the first
#	options are on screen at once, with no scrolling to find them (menu.js
#	setOptions / revealOptions); and the twelve languages, a list taller than the window,
#	which puts its row at the top.
	$(SHOT) --screenshot=/out/13-select-deep.png "http://serve:8080/index.html?section=hints&keys=down,down,down,down,down,down,enter"
	$(SHOT) --screenshot=/out/13-select-long.png "http://serve:8080/index.html?section=common&expand=appLanguage"
#	The palettes on the dock and on the window: light, and contrast with an accent.
	$(SHOT) --screenshot=/out/14-light.png "http://serve:8080/index.html?theme=light&cols=2"
	$(SHOT) --screenshot=/out/15-light-window.png "http://serve:8080/index.html?section=theme&theme=light"
	$(SHOT) --screenshot=/out/16-contrast.png "http://serve:8080/index.html?labels=10&hints=1&theme=contrast&accent=cyan&keys=down"
	$(SHOT) --screenshot=/out/17-contrast-window.png "http://serve:8080/index.html?section=theme&theme=contrast&accent=cyan"
#	The background pictures behind the dock, and behind both columns of the window.
	$(SHOT) --screenshot=/out/18-bg-dock.png "http://serve:8080/index.html?bg=100&cols=2"
	$(SHOT) --screenshot=/out/19-bg-window.png "http://serve:8080/index.html?section=bg&bg=100&bgRail=100"
#	Transparency at its ceiling (70): the picture through everything the app draws.
	$(SHOT) --screenshot=/out/20-transparency.png "http://serve:8080/index.html?transparency=70"
#	The pending balloon, centred and in a corner.
	$(SHOT) --screenshot=/out/21-busy.png "http://serve:8080/index.html?toast=busy"
	$(SHOT) --screenshot=/out/22-busy-corner.png "http://serve:8080/index.html?toast=busy&toastAt=bottom-right"
#	The one shot that is not English: a Russian window, to check the locale and its longer labels.
#	Every other shot is English (a fresh install is English whatever the TV's language is).
	$(SHOT) --screenshot=/out/24-ru-window.png "http://serve:8080/index.html?lang=ru&section=tweaks"
#	Nothing on screen: the dock hidden.
	$(SHOT) --screenshot=/out/25-hidden.png "http://serve:8080/index.html?panel=0"
	@echo Done: test/shots/

.PHONY: shell
shell: docker-build ## Bash inside ares-* container
	$(ARES) bash

# =============================================================================
# TV SETUP & OPERATIONS
# =============================================================================
# The whole of what a TV is for here: register the device, put the package there,
# start and stop it. Nothing reads the TV or runs commands on it — the dock is
# developed and checked in the emulator (make dev / shots / smoke), and root for
# the helper service is asked for in the app itself (Settings -> Tweaks ->
# Request privileges), not from the host.
.PHONY: tv-add
tv-add: docker-build ## Register Developer Mode TV (requires TV=<ip> NAME=<name>)
	@test -n "$(TV)" || (echo "Usage: make tv-add TV=<ip> NAME=<device-name>"; echo "Example: make tv-add TV=192.168.1.50 NAME=tv"; exit 1)
	@test -n "$(NAME)" || (echo "Usage: make tv-add TV=<ip> NAME=<device-name>"; echo "Example: make tv-add TV=192.168.1.50 NAME=tv"; exit 1)
	$(ARES) ares-setup-device --add $(NAME) \
		-i "host=$(TV)" -i "port=$(PORT)" -i "username=$(USER)" -i "default=true"
	$(BLANK_LINE)
	@echo ✓ Device '$(NAME)' registered
	@echo $(Q)Next: enable Developer Mode on the TV and run 'make tv-key NAME=$(NAME)' (needs the passphrase from the Developer Mode app).$(Q)

# A TV rooted with webosbrew runs a real sshd on port 22, where the account is
# root with the password alpine, and the Developer Mode key dance does not apply:
# the device profile carries that password instead of a private key. Everything
# else — install, launch, uninstall — then goes through the profile as usual.
ROOT_PORT ?= 22
ROOT_USER ?= root
ROOT_PASS ?= alpine

.PHONY: tv-add-root
tv-add-root: docker-build ## Register rooted TV with webosbrew (requires TV=<ip> NAME=<name>)
	@test -n "$(TV)" || (echo "Usage: make tv-add-root TV=<ip> NAME=<device-name>"; echo "Example: make tv-add-root TV=192.168.1.97 NAME=tv2"; exit 1)
	@test -n "$(NAME)" || (echo "Usage: make tv-add-root TV=<ip> NAME=<device-name>"; echo "Example: make tv-add-root TV=192.168.1.97 NAME=tv2"; exit 1)
	$(ARES) ares-setup-device --add $(NAME) \
		-i "host=$(TV)" -i "port=$(ROOT_PORT)" -i "username=$(ROOT_USER)" \
		-i "password=$(ROOT_PASS)" -i "default=true"
	$(BLANK_LINE)
	@echo ✓ Device '$(NAME)' registered
	@echo No 'make tv-key' needed on a rooted TV. Check with 'make tv-list', then 'make deploy DEVICE=$(NAME)'.

.PHONY: tv-key
tv-key: docker-build ## Fetch developer key from TV (NAME=<name> optional)
	@DEVICE_NAME="$(if $(NAME),$(NAME),$(DEVICE))"; \
	echo "Fetching key from device: $$DEVICE_NAME"; \
	$(ARES) ares-novacom --device "$$DEVICE_NAME" --getkey

.PHONY: tv-list
tv-list: docker-build ## List registered devices
	$(ARES) ares-setup-device --list

.PHONY: tv-remove
tv-remove: docker-build ## Remove a registered device (requires NAME=<name>)
	@test -n "$(NAME)" || (echo "Usage: make tv-remove NAME=<device-name>"; echo "Example: make tv-remove NAME=fox50"; exit 1)
	$(ARES) ares-setup-device --remove $(NAME)
	$(BLANK_LINE)
	@echo ✓ Device '$(NAME)' removed
	@echo Check with 'make tv-list'.

.PHONY: tv-reset
tv-reset: docker-build ## Reset all registered devices (requires Git Bash on Windows)
	@echo $(Q)NOTE: On Windows, this target requires Git Bash (sh.exe must be in PATH).$(Q)
	@echo $(Q)WARNING: This will remove ALL registered devices (emulator will remain).$(Q)
	@echo -n "Are you sure? [y/N] " && read ans && [ $${ans:-N} = y ]
	$(ARES) ares-setup-device --reset
	$(BLANK_LINE)
	@echo ✓ All devices removed
	@echo Built-in emulator remains. Re-register TVs with 'make tv-add' or 'make tv-add-root'.

.PHONY: tv-use-tv
tv-use-tv: docker-build ## Switch to TV device
	$(ARES) ares-setup-device -f tv
	$(BLANK_LINE)
	@echo ✓ Default device switched to: tv

.PHONY: tv-use-emulator
tv-use-emulator: docker-build ## Switch to emulator device
	$(ARES) ares-setup-device -f emulator
	$(BLANK_LINE)
	@echo ✓ Default device switched to: emulator

# Pattern rule for switching to any device: make tv-use-<device-name>
tv-use-%: docker-build
	$(ARES) ares-setup-device -f "$*"
	$(BLANK_LINE)
	@echo ✓ Default device switched to: $*

.PHONY: install
install: ## Install IPK on registered TV
	$(DC) run --rm -e DEVICE=$(DEVICE) -e APP_ID=$(APP_ID) ares sh tools/install.sh $(IPK)

.PHONY: launch
launch: docker-build ## Launch app on TV
	$(ARES) ares-launch $(if $(DEVICE),--device $(DEVICE)) $(APP_ID)

.PHONY: close
close: docker-build ## Close running app on TV
	$(ARES) ares-launch $(if $(DEVICE),--device $(DEVICE)) --close $(APP_ID)

.PHONY: inspect
inspect: docker-build ## Open Chrome DevTools for remote debugging
	@echo Starting ares-inspect...
	@echo $(Q)Note: ares-inspect will show the DevTools URL with a random port (35000-36000)$(Q)
	@echo Copy the full URL from output and open in Chrome
	@echo Example: http://localhost:35611/devtools/inspector.html?ws=...
	$(ARES) ares-inspect $(if $(DEVICE),--device $(DEVICE)) --app $(APP_ID)

.PHONY: deploy
deploy: ## Deploy existing IPK to TV and launch
	@echo === Deployment workflow ===
	@echo 1. Installing on TV...
	$(MAKE) install
	@echo 2. Launching app...
	$(MAKE) launch
	@echo === Deployment complete ===

.PHONY: uninstall
uninstall: docker-build ## Remove app from TV
	$(ARES) ares-install $(if $(DEVICE),--device $(DEVICE)) --remove $(APP_ID)

# =============================================================================
# CLEANUP
# =============================================================================
.PHONY: clean
clean: ## Remove build/ and test/ directories
	$(DC) run --rm icons sh -c "rm -rf /app/build /app/test"

.PHONY: distclean
distclean: clean ## Deep clean: remove dist/, containers, and images
	$(DC) run --rm icons sh -c "rm -rf /app/dist"
	$(DC) down -v --rmi local
