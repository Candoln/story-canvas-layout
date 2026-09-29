const { FuzzySuggestModal, ItemView, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TextComponent, setIcon } = require("obsidian");

const DEFAULT_GAP = 36;
const DEFAULT_PADDING = 46;
const MIN_GROUP_WIDTH = 280;
const MIN_GROUP_HEIGHT = 190;

const DEFAULT_SETTINGS = {
  defaultGap: 36,
  defaultPadding: 46,
  defaultNestedSpacing: 16,
  defaultNestedInset: 20,
  followFrameVersionName: false,
  toolbar: {
    createFrameButtons: true,
    versionNavigation: true,
    versionOverview: true,
    versionMetadata: true,
    duplicateVersion: true,
    blankVersion: true,
    deleteVersion: true,
    pause: true,
    direction: true,
    gap: false,
    padding: false,
    nestedSpacing: false,
    nestedInset: false
  }
};

class StoryCanvasLayoutSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Story Canvas Layout" });

    containerEl.createEl("h3", { text: "Frame popup toolbar" });
    containerEl.createDiv({
      cls: "setting-item-description",
      text: "Choose which Story Canvas Layout controls appear in the compact toolbar above a selected managed Frame. Right-click commands remain available even when a toolbar control is hidden."
    });

    const toolbarToggles = [
      ["createFrameButtons", "Create Vertical / Horizontal Frame", "Show layout creation buttons when ordinary Canvas cards are selected."],
      ["versionNavigation", "Version navigation", "Previous / page counter / Next."],
      ["versionOverview", "Version overview", "Open the Frame Version list."],
      ["versionMetadata", "Branch name & description", "Edit the active Frame Version branch name and description."],
      ["duplicateVersion", "Duplicate branch", "Duplicate the current Frame Version as an independent Canvas-node branch."],
      ["blankVersion", "New blank branch", "Create a blank Frame Version."],
      ["deleteVersion", "Delete current branch", "Show a delete button when more than one Frame branch exists."],
      ["pause", "Pause / Resume", "Pause or resume managed layout."],
      ["direction", "Vertical / Horizontal switch", "Switch Frame direction."],
      ["gap", "Gap controls", "Show Gap - / + in the compact toolbar."],
      ["padding", "Padding controls", "Show Padding - / + in the compact toolbar."],
      ["nestedSpacing", "Nested spacing controls", "Show Nested spacing - / + in the compact toolbar."],
      ["nestedInset", "Nested inset controls", "Show Nested inset - / + in the compact toolbar."]
    ];

    for (const [key, name, desc] of toolbarToggles) {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((toggle) => {
          toggle
            .setValue(!!this.plugin.settings.toolbar[key])
            .onChange(async (value) => {
              this.plugin.settings.toolbar[key] = value;
              await this.plugin.saveSettings();
              this.plugin.refreshToolbarSettings();
            });
        });
    }

    containerEl.createEl("h3", { text: "Default layout spacing" });
    containerEl.createDiv({
      cls: "setting-item-description",
      text: "These values are used by newly created Frames and by the corresponding Reset commands. Existing Frames keep their own saved values."
    });

    const addNumber = (key, name, desc, min = 0, max = 240) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) => {
          text
            .setValue(String(this.plugin.settings[key]))
            .onChange(async (value) => {
              const parsed = Number(value);
              if (!Number.isFinite(parsed)) return;
              this.plugin.settings[key] = Math.max(min, Math.min(max, Math.round(parsed)));
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "number";
          text.inputEl.min = String(min);
          text.inputEl.max = String(max);
          text.inputEl.step = "1";
        });
    };

    addNumber("defaultGap", "Default gap", "Space between direct children in a managed Frame.");
    addNumber("defaultPadding", "Default padding", "Space between Frame edge and direct children.");
    addNumber("defaultNestedSpacing", "Default nested spacing", "Extra main-axis spacing around nested managed Frames.");
    addNumber("defaultNestedInset", "Default nested inset", "Extra cross-axis inset applied to nested managed Frames.");

    containerEl.createEl("h3", { text: "Frame Version naming" });

    new Setting(containerEl)
      .setName("Use active branch name as Canvas Frame name")
      .setDesc("When enabled, a managed Frame's Canvas label follows the active Frame Version branch name. An unnamed branch is shown as “Frame Version N”. Turn this off to keep Canvas Frame labels independent.")
      .addToggle((toggle) => {
        toggle
          .setValue(!!this.plugin.settings.followFrameVersionName)
          .onChange(async (value) => {
            this.plugin.settings.followFrameVersionName = value;
            await this.plugin.saveSettings();
            if (value) {
              this.plugin.syncFrameLabelsForOpenCanvases();
            }
          });
      });
  }
}


const clone = (v) => JSON.parse(JSON.stringify(v));
const uid = () => Math.random().toString(36).slice(2, 10);

module.exports = class StoryCanvasLayoutPlugin extends Plugin {
  async onload() {
    const loaded = await this.loadData();
    this.state = loaded && loaded.canvases
      ? loaded
      : { canvases: {}, repairBackups: [] };

    if (!this.state.repairBackups) {
      this.state.repairBackups = [];
    }

    const storedSettings =
      this.state.settings && typeof this.state.settings === "object"
        ? this.state.settings
        : {};

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...storedSettings,
      toolbar: {
        ...DEFAULT_SETTINGS.toolbar,
        ...(storedSettings.toolbar || {})
      }
    };
    this.state.settings = this.settings;

    // Serialize plugin-state writes. Watchers, drag/drop, version switching and
    // lifecycle preparation can all save state close together. Without a queue,
    // an older async save may finish after a newer one and overwrite it.
    this.stateSaveChain = Promise.resolve();

    this.addSettingTab(
      new StoryCanvasLayoutSettingTab(this.app, this)
    );

    this.pointerHost = null;
    this.pointerDownHandler = null;
    this.pointerMoveHandler = null;
    this.pointerUpHandler = null;
    this.pointerCancelHandler = null;
    this.windowBlurHandler = null;
    this.dropHandler = null;
    this.dragOverHandler = null;
    this.dragState = null;
    this.indicator = null;
    this.lastPointer = null;
    this.injectedToolbarEls = new Set();
    this.popupObserver = null;
    this.popupHost = null;
    this.popupRefreshRaf = null;
    this.nodeGeometry = new Map();
    this.frameRelativeGeometry = new Map();
    this.frameVersionHiddenNodes = new Map();
    this.geometryIgnoreUntil = new Map();
    this.canvasNodeIdSnapshots = new Map();
    this.geometryTimer = null;
    this.geometryCanvas = null;
    this.geometryPath = null;

    this.boundCanvas = null;
    this.boundCanvasPath = null;
    this.boundCanvasHost = null;

    // Track all currently-open Canvas views, not only the active one.
    this.canvasBindings = new Map();
    this.canvasPrepareTimers = new Set();
    this.lifecycleTimer = null;
    this.prepareTimers = new Set();

    this.registerCommands();
    this.registerCanvasMenus();

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      void this.handleVaultFileRename(file, oldPath);
    }));

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.queuePrepareAllCanvases();
    }));

    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.queuePrepareAllCanvases();
    }));

    this.registerEvent(this.app.workspace.on("file-open", () => {
      this.queuePrepareAllCanvases();
    }));

    this.lifecycleTimer = window.setInterval(() => {
      this.ensureAllCanvasBindings();
    }, 1500);

    this.queuePrepareAllCanvases();
  }

  onunload() {
    this.detachPointerListeners();
    this.clearIndicator();
    if (this.geometryTimer) window.clearInterval(this.geometryTimer);
    this.geometryTimer = null;
    this.geometryCanvas = null;
    this.geometryPath = null;
    this.nodeGeometry.clear();
    this.frameRelativeGeometry.clear();
    this.frameVersionHiddenNodes.clear();
    this.geometryIgnoreUntil.clear();
    this.canvasNodeIdSnapshots.clear();

    if (this.lifecycleTimer) window.clearInterval(this.lifecycleTimer);
    this.lifecycleTimer = null;

    for (const timer of this.prepareTimers) {
      window.clearTimeout(timer);
    }
    this.prepareTimers.clear();

    this.boundCanvas = null;
    this.boundCanvasPath = null;
    this.boundCanvasHost = null;

    for (const timer of this.canvasPrepareTimers) {
      window.clearTimeout(timer);
    }
    this.canvasPrepareTimers.clear();

    for (const binding of this.canvasBindings.values()) {
      if (binding && binding.popupObserver) {
        try { binding.popupObserver.disconnect(); } catch (_) {}
      }
    }
    this.canvasBindings.clear();

    this.detachPopupObserver();
    for (const el of this.injectedToolbarEls) el.remove();
    this.injectedToolbarEls.clear();
  }

  persistState() {
    const snapshot = clone(this.state);

    this.stateSaveChain =
      (this.stateSaveChain || Promise.resolve())
        .catch(() => {})
        .then(() => this.saveData(snapshot));

    return this.stateSaveChain;
  }

  async saveSettings() {
    this.state.settings = this.settings;
    await this.persistState();
  }

  refreshToolbarSettings() {
    for (const el of [...this.injectedToolbarEls]) {
      if (
        el &&
        (
          el.classList.contains("story-layout-popup-tools") ||
          el.classList.contains("story-layout-card-menu-tools")
        )
      ) {
        el.remove();
        this.injectedToolbarEls.delete(el);
      }
    }

    this.queuePrepareAllCanvases();
  }

  isMobilePlatform() {
    return !!(
      Platform &&
      (
        Platform.isMobile ||
        Platform.isMobileApp
      )
    );
  }

  pointerMoveThreshold(ev) {
    // Finger movement has natural jitter. Desktop keeps the original 4px
    // threshold; touch/pen gets a more forgiving threshold so a tap or Canvas
    // pan is less likely to be interpreted as Story Layout insertion drag.
    if (
      ev &&
      (
        ev.pointerType === "touch" ||
        ev.pointerType === "pen"
      )
    ) {
      return 12;
    }

    return 4;
  }

  defaultGap() {
    return Number.isFinite(this.settings.defaultGap)
      ? this.settings.defaultGap
      : DEFAULT_GAP;
  }

  defaultPadding() {
    return Number.isFinite(this.settings.defaultPadding)
      ? this.settings.defaultPadding
      : DEFAULT_PADDING;
  }

  defaultNestedSpacing() {
    return Number.isFinite(this.settings.defaultNestedSpacing)
      ? this.settings.defaultNestedSpacing
      : 16;
  }

  defaultNestedInset() {
    return Number.isFinite(this.settings.defaultNestedInset)
      ? this.settings.defaultNestedInset
      : 20;
  }

  updateFrameLabelFromActiveVersion(canvas, path, groupId) {
    if (!this.settings.followFrameVersionName) return false;

    const versionState = this.getFrameVersionState(path, groupId, false);
    if (!versionState || !versionState.versions.length) return false;

    const index = Math.max(
      0,
      Math.min(versionState.active || 0, versionState.versions.length - 1)
    );
    const version = versionState.versions[index];
    const label =
      version && typeof version.label === "string" && version.label.trim()
        ? version.label.trim()
        : `Frame Version ${index + 1}`;

    this.patchLiveNode(canvas, groupId, { label });
    return true;
  }

  syncFrameLabelsForOpenCanvases() {
    for (const context of this.allCanvasContexts()) {
      const { canvas, path } = context;
      const state = this.canvasState(path, false);
      if (!state || !state.frameVersions) continue;

      for (const groupId of Object.keys(state.frameVersions)) {
        this.updateFrameLabelFromActiveVersion(
          canvas,
          path,
          groupId
        );
      }

      canvas.requestSave(false);
      this.decorate(canvas, path);
    }
  }

  async readCanvasDiskJson(path) {
    const file =
      this.app.vault.getAbstractFileByPath(path);

    if (
      !file ||
      typeof this.app.vault.read !== "function"
    ) {
      return null;
    }

    try {
      const raw =
        await this.app.vault.read(file);
      return JSON.parse(raw);
    } catch (error) {
      console.warn(
        "[Story Canvas Layout] Could not read Canvas JSON for diagnostics.",
        error
      );
      return null;
    }
  }

  selectedGroupIds(canvas) {
    if (!canvas || !canvas.selection) return [];

    return [...canvas.selection]
      .map((node) => {
        try {
          return node.getData();
        } catch (_) {
          return null;
        }
      })
      .filter(
        (data) =>
          data &&
          data.type === "group" &&
          typeof data.id === "string"
      )
      .map((data) => data.id);
  }

  async managedFramePersistenceReport(
    canvas,
    path
  ) {
    const state =
      this.canvasState(path, false);

    let serialized = null;
    try {
      serialized =
        typeof canvas.getData === "function"
          ? canvas.getData()
          : null;
    } catch (_) {
      serialized = null;
    }

    const disk =
      await this.readCanvasDiskJson(path);

    const selectedGroups =
      this.selectedGroupIds(canvas);

    const ids = new Set(selectedGroups);

    for (const id of Object.keys(
      (state && state.frames) || {}
    )) {
      ids.add(id);
    }

    for (const node of
      (serialized && serialized.nodes) || []) {
      if (
        node &&
        node.type === "group" &&
        node.storyCanvasLayoutFrame &&
        node.storyCanvasLayoutFrame.managed === true
      ) {
        ids.add(node.id);
      }
    }

    for (const node of
      (disk && disk.nodes) || []) {
      if (
        node &&
        node.type === "group" &&
        node.storyCanvasLayoutFrame &&
        node.storyCanvasLayoutFrame.managed === true
      ) {
        ids.add(node.id);
      }
    }

    const rows = [];

    for (const id of ids) {
      const liveNode =
        canvas.nodes &&
        canvas.nodes.get(id);

      let liveData = null;
      try {
        liveData =
          liveNode &&
          typeof liveNode.getData === "function"
            ? liveNode.getData()
            : null;
      } catch (_) {
        liveData = null;
      }

      const serializedNode =
        serialized &&
        Array.isArray(serialized.nodes)
          ? serialized.nodes.find(
              (node) => node && node.id === id
            )
          : null;

      const diskNode =
        disk &&
        Array.isArray(disk.nodes)
          ? disk.nodes.find(
              (node) => node && node.id === id
            )
          : null;

      rows.push({
        id,
        selected: selectedGroups.includes(id),
        pluginState:
          !!(
            state &&
            state.frames &&
            state.frames[id]
          ),
        liveNode:
          !!liveNode,
        liveMarker:
          !!(
            liveData &&
            liveData.storyCanvasLayoutFrame &&
            liveData.storyCanvasLayoutFrame.managed === true
          ),
        serializedMarker:
          !!(
            serializedNode &&
            serializedNode.storyCanvasLayoutFrame &&
            serializedNode.storyCanvasLayoutFrame.managed === true
          ),
        diskMarker:
          !!(
            diskNode &&
            diskNode.storyCanvasLayoutFrame &&
            diskNode.storyCanvasLayoutFrame.managed === true
          )
      });
    }

    const basename =
      String(path).split("/").pop();

    const stalePathBuckets =
      Object.keys(this.state.canvases || {})
        .filter(
          (key) =>
            key !== path &&
            String(key).split("/").pop() === basename
        );

    return {
      path,
      rows,
      diskReadable: !!disk,
      stalePathBuckets,
      stateCount:
        Object.keys(
          (state && state.frames) || {}
        ).length
    };
  }

  async openManagedFramePersistenceDiagnostics(
    canvas,
    path
  ) {
    const report =
      await this.managedFramePersistenceReport(
        canvas,
        path
      );

    const plugin = this;

    class ManagedFrameDiagnosticsModal extends Modal {
      onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass(
          "story-managed-frame-diagnostics"
        );

        contentEl.createEl("h2", {
          text: "Managed Frame persistence diagnostics"
        });

        contentEl.createEl("p", {
          text: `Canvas: ${report.path}`
        });

        if (!report.diskReadable) {
          contentEl.createEl("p", {
            cls: "mod-warning",
            text: "Could not read the .canvas file from the Vault. Disk JSON status is unavailable."
          });
        }

        if (
          report.stalePathBuckets &&
          report.stalePathBuckets.length
        ) {
          contentEl.createEl("p", {
            cls: "mod-warning",
            text:
              `Stale Canvas state bucket(s) with the same filename: ${report.stalePathBuckets.join(", ")}`
          });
        }

        if (!report.rows.length) {
          contentEl.createEl("p", {
            text: "No managed Frame state or marker was found."
          });
          return;
        }

        const table =
          contentEl.createEl("table", {
            cls: "story-managed-frame-diagnostics-table"
          });

        const head = table.createEl("thead");
        const headRow = head.createEl("tr");

        for (const label of [
          "Frame",
          "data.json",
          "Live",
          "Live marker",
          "Canvas data",
          "Disk JSON"
        ]) {
          headRow.createEl("th", {
            text: label
          });
        }

        const body = table.createEl("tbody");

        for (const row of report.rows) {
          const tr = body.createEl("tr");
          if (row.selected) {
            tr.addClass("is-selected");
          }

          tr.createEl("td", {
            text: row.id.slice(0, 10)
          });

          const values = [
            row.pluginState,
            row.liveNode,
            row.liveMarker,
            row.serializedMarker,
            row.diskMarker
          ];

          for (const value of values) {
            tr.createEl("td", {
              text: value ? "YES" : "NO"
            });
          }
        }

        contentEl.createEl("p", {
          cls: "setting-item-description",
          text:
            "The critical column is Disk JSON. If Disk JSON = YES but the Frame is not managed after restart, the bug is runtime recovery. If Live/Canvas = YES but Disk JSON = NO, the bug is save persistence."
        });

        const actions =
          contentEl.createDiv({
            cls: "story-version-rename-actions"
          });

        const forceSave =
          actions.createEl("button", {
            text: "Force-save managed identities",
            cls: "mod-cta"
          });

        forceSave.addEventListener(
          "click",
          async () => {
            const state =
              plugin.canvasState(
                path,
                false
              );

            if (state && state.frames) {
              for (const frame of Object.values(
                state.frames
              )) {
                plugin.flushManagedFrameIdentity(
                  canvas,
                  path,
                  frame
                );
              }

              canvas.requestSave(false);
              await plugin.persistState();
            }

            new Notice(
              "Requested managed Frame identity save. Run diagnostics again after Obsidian finishes saving."
            );

            this.close();
          }
        );
      }

      onClose() {
        this.contentEl.empty();
      }
    }

    new ManagedFrameDiagnosticsModal(
      this.app
    ).open();
  }

  registerCommands() {
    this.addCommand({
      id: "create-vertical-layout-frame",
      name: "Create vertical layout frame from selection",
      checkCallback: (checking) => this.withCanvas((canvas, path) => {
        const nodes = this.selectedNonGroupNodes(canvas);
        if (!nodes.length) return false;
        if (!checking) void this.createFrame(canvas, path, "vertical", nodes);
        return true;
      })
    });

    this.addCommand({
      id: "create-horizontal-layout-frame",
      name: "Create horizontal layout frame from selection",
      checkCallback: (checking) => this.withCanvas((canvas, path) => {
        const nodes = this.selectedNonGroupNodes(canvas);
        if (!nodes.length) return false;
        if (!checking) void this.createFrame(canvas, path, "horizontal", nodes);
        return true;
      })
    });

    this.addCommand({
      id: "create-empty-vertical-layout-frame",
      name: "Create empty vertical layout frame",
      checkCallback: (checking) => this.withCanvas((canvas, path) => {
        if (!checking) void this.createEmptyFrameAtCenter(canvas, path, "vertical");
        return true;
      })
    });

    this.addCommand({
      id: "create-empty-horizontal-layout-frame",
      name: "Create empty horizontal layout frame",
      checkCallback: (checking) => this.withCanvas((canvas, path) => {
        if (!checking) void this.createEmptyFrameAtCenter(canvas, path, "horizontal");
        return true;
      })
    });

    this.addCommand({
      id: "reflow-layout-frames",
      name: "Reflow all layout frames",
      checkCallback: (checking) => this.withCanvas((canvas, path) => {
        if (!this.canvasState(path, false)) return false;
        if (!checking) void this.reflowAll(canvas, path);
        return true;
      })
    });

    this.addCommand({
      id: "toggle-layout-frame-direction",
      name: "Toggle selected layout frame direction",
      checkCallback: (checking) => this.withCanvas((canvas, path) => {
        const frame = this.selectedManagedFrame(canvas, path);
        if (!frame) return false;
        if (!checking) {
          frame.direction = frame.direction === "vertical" ? "horizontal" : "vertical";
          void this.persistAndReflow(canvas, path, frame);
        }
        return true;
      })
    });

    this.addCommand({
      id: "diagnose-managed-frame-persistence",
      name: "Diagnose managed Frame persistence",
      checkCallback: (checking) =>
        this.withCanvas((canvas, path) => {
          if (!checking) {
            void this.openManagedFramePersistenceDiagnostics(
              canvas,
              path
            );
          }
          return true;
        })
    });

    this.addCommand({
      id: "open-broken-note-version-overview",
      name: "Open broken Note Version overview",
      checkCallback: (checking) => this.withCanvas((canvas, path) => {
        if (!this.canvasState(path, false)) return false;
        if (!checking) {
          this.openBrokenNoteVersionOverview(canvas, path);
        }
        return true;
      })
    });

    this.addCommand({
      id: "restore-repair-backup",
      name: "Restore repair backup",
      checkCallback: (checking) => this.withCanvas((canvas, path) => {
        const backups = this.repairBackupsForPath(path);
        if (!backups.length) return false;

        if (!checking) {
          this.openRepairBackupRestoreModal(canvas, path);
        }
        return true;
      })
    });

    this.addCommand({
      id: "repair-current-canvas-state",
      name: "Repair current Canvas state",
      checkCallback: (checking) => this.withCanvas((canvas, path) => {
        if (!this.canvasState(path, false)) return false;
        if (!checking) {
          void this.repairCanvasState(canvas, path, {
            notify: true,
            reason: "manual"
          });
        }
        return true;
      })
    });

    this.addCommand({
      id: "remove-selected-layout-frame",
      name: "Stop managing selected layout frame",
      checkCallback: (checking) => this.withCanvas((canvas, path) => {
        const frame = this.selectedManagedFrame(canvas, path);
        if (!frame) return false;
        if (!checking) void this.stopManagingFrame(canvas, path, frame);
        return true;
      })
    });
  }

  registerCanvasMenus() {
    // Built-in but currently untyped Canvas events used by many Canvas plugins.
    this.registerEvent(this.app.workspace.on("canvas:node-menu", (menu, node) => {
      try {
        const nodeCanvas =
          node && node.canvas
            ? node.canvas
            : null;

        const context =
          this.canvasContext(nodeCanvas);

        const data =
          node &&
          typeof node.getData === "function"
            ? node.getData()
            : null;

        if (
          context &&
          data &&
          data.id &&
          this.managedParentFramesForNode(
            context.path,
            data.id
          ).length
        ) {
          menu.addItem((item) =>
            item
              .setTitle("Detach from Story Frame")
              .setIcon("unlink")
              .onClick(() => {
                void this.detachNodeFromManagedFrames(
                  context.canvas,
                  context.path,
                  data.id
                );
              })
          );
        }
      } catch (_) {}


      const canvas = node && node.canvas;
      if (!canvas) return;

      const context = this.canvasContext(canvas);
      if (!context) return;

      const path = context.path;

      const selected = this.selectedNonGroupNodes(canvas);
      const usable = selected.length ? selected : [node.getData()].filter((n) => n.type !== "group");

      if (usable.length) {
        menu.addSeparator();
        menu.addItem((item) => item
          .setTitle("Create vertical layout frame")
          .setIcon("rows-3")
          .onClick(() => void this.createFrame(canvas, path, "vertical", usable)));
        menu.addItem((item) => item
          .setTitle("Create horizontal layout frame")
          .setIcon("columns-3")
          .onClick(() => void this.createFrame(canvas, path, "horizontal", usable)));
      }

      const nodeData = node && typeof node.getData === "function" ? node.getData() : null;
      if (nodeData && nodeData.type === "text") {
        const versionState = this.getCardVersionState(path, node.id, false);

        menu.addSeparator();

        if (versionState) {
          menu.addItem((item) => item
            .setTitle(`Previous version (${versionState.active + 1}/${versionState.versions.length})`)
            .setIcon("chevron-left")
            .setDisabled(versionState.versions.length < 2)
            .onClick(() => void this.switchCardVersion(canvas, path, node.id, -1)));

          menu.addItem((item) => item
            .setTitle(`Next version (${versionState.active + 1}/${versionState.versions.length})`)
            .setIcon("chevron-right")
            .setDisabled(versionState.versions.length < 2)
            .onClick(() => void this.switchCardVersion(canvas, path, node.id, 1)));

          menu.addItem((item) => item
            .setTitle("Open version overview")
            .setIcon("list")
            .onClick(() => {
              this.openCardVersionOverview(canvas, path, node.id);
            }));
        }

        menu.addItem((item) => item
          .setTitle("Duplicate as new version")
          .setIcon("copy-plus")
          .onClick(() => void this.duplicateCardVersion(canvas, path, node.id)));

        menu.addItem((item) => item
          .setTitle("New blank version")
          .setIcon("file-plus")
          .onClick(() => void this.newBlankCardVersion(canvas, path, node.id)));

        if (versionState) {
          const activeVersion = versionState.versions[versionState.active];
          menu.addItem((item) => item
            .setTitle(activeVersion && activeVersion.label ? `Rename version: ${activeVersion.label}` : "Name current version")
            .setIcon("tag")
            .onClick(() => {
              this.openRenameVersionModal(canvas, path, node.id);
            }));
        }

        if (versionState && versionState.versions.length > 1) {
          menu.addItem((item) => item
            .setTitle("Delete current version")
            .setIcon("trash-2")
            .onClick(() => void this.deleteCurrentCardVersion(canvas, path, node.id)));
        }

        if (versionState) {
          menu.addItem((item) => item
            .setTitle("Remove version history")
            .setIcon("history")
            .onClick(() => void this.removeCardVersionHistory(canvas, path, node.id)));
        }
      }

      if (nodeData && nodeData.type === "file") {
        const noteState = this.getNoteVersionState(path, node.id, false);

        menu.addSeparator();

        if (noteState) {
          const currentNoteVersion =
            noteState.versions[noteState.active];

          const currentNoteMissing =
            !currentNoteVersion ||
            !currentNoteVersion.file ||
            !this.app.vault.getAbstractFileByPath(
              currentNoteVersion.file
            );

          if (currentNoteMissing) {
            menu.addItem((item) => item
              .setTitle("Relink missing current note version")
              .setIcon("link")
              .onClick(() => {
                this.openRelinkNoteVersionPicker(
                  canvas,
                  path,
                  node.id,
                  noteState.active
                );
              }));
          }

          menu.addItem((item) => item
            .setTitle(`Previous note version (${noteState.active + 1}/${noteState.versions.length})`)
            .setIcon("chevron-left")
            .setDisabled(noteState.versions.length < 2)
            .onClick(() => void this.switchNoteVersion(canvas, path, node.id, -1)));

          menu.addItem((item) => item
            .setTitle(`Next note version (${noteState.active + 1}/${noteState.versions.length})`)
            .setIcon("chevron-right")
            .setDisabled(noteState.versions.length < 2)
            .onClick(() => void this.switchNoteVersion(canvas, path, node.id, 1)));

          menu.addItem((item) => item
            .setTitle("Open note version overview")
            .setIcon("list")
            .onClick(() => this.openNoteVersionOverview(canvas, path, node.id)));

          const activeVersion = noteState.versions[noteState.active];
          menu.addItem((item) => item
            .setTitle(activeVersion && activeVersion.label ? `Rename note version: ${activeVersion.label}` : "Name current note version")
            .setIcon("tag")
            .onClick(() => this.openRenameNoteVersionModal(canvas, path, node.id)));
        }

        menu.addItem((item) => item
          .setTitle("Create blank note version")
          .setIcon("file-plus")
          .onClick(() => this.openCreateBlankNoteVersionModal(canvas, path, node.id)));

        menu.addItem((item) => item
          .setTitle("Add existing note as version")
          .setIcon("file-search")
          .onClick(() => this.openAddExistingNoteVersionPicker(canvas, path, node.id)));

        if (noteState && noteState.versions.length > 1) {
          menu.addItem((item) => item
            .setTitle("Delete current note version")
            .setIcon("trash-2")
            .onClick(() => void this.deleteCurrentNoteVersion(canvas, path, node.id)));
        }
      }

      const frame = this.frameForNodeId(path, node.id);
      if (frame && frame.groupId === node.id) {
        menu.addSeparator();
        menu.addItem((item) => item
          .setTitle(frame.direction === "vertical" ? "Switch to horizontal layout" : "Switch to vertical layout")
          .setIcon("replace")
          .onClick(() => {
            frame.direction = frame.direction === "vertical" ? "horizontal" : "vertical";
            void this.persistAndReflow(canvas, path, frame);
          }));

        const frameVersionState = this.getFrameVersionState(path, frame.groupId, false);

        menu.addSeparator();

        if (frameVersionState) {
          menu.addItem((item) => item
            .setTitle(`Previous frame version (${frameVersionState.active + 1}/${frameVersionState.versions.length})`)
            .setIcon("chevron-left")
            .setDisabled(frameVersionState.versions.length < 2)
            .onClick(() => void this.switchFrameVersion(canvas, path, frame.groupId, -1)));

          menu.addItem((item) => item
            .setTitle(`Next frame version (${frameVersionState.active + 1}/${frameVersionState.versions.length})`)
            .setIcon("chevron-right")
            .setDisabled(frameVersionState.versions.length < 2)
            .onClick(() => void this.switchFrameVersion(canvas, path, frame.groupId, 1)));

          menu.addItem((item) => item
            .setTitle("Open frame version overview")
            .setIcon("list")
            .onClick(() => this.openFrameVersionOverview(canvas, path, frame.groupId)));

          const activeFrameVersion = frameVersionState.versions[frameVersionState.active];
          menu.addItem((item) => item
            .setTitle(
              activeFrameVersion && activeFrameVersion.label
                ? `Rename frame version: ${activeFrameVersion.label}`
                : "Name current frame version"
            )
            .setIcon("tag")
            .onClick(() => this.openRenameFrameVersionModal(canvas, path, frame.groupId)));
        }

        menu.addItem((item) => item
          .setTitle("Duplicate current frame version")
          .setIcon("copy-plus")
          .onClick(() => void this.duplicateFrameVersion(canvas, path, frame.groupId)));

        menu.addItem((item) => item
          .setTitle("New blank frame version")
          .setIcon("file-plus")
          .onClick(() => void this.newBlankFrameVersion(canvas, path, frame.groupId)));

        if (frameVersionState && frameVersionState.versions.length > 1) {
          menu.addItem((item) => item
            .setTitle("Delete current frame version")
            .setIcon("trash-2")
            .onClick(() => void this.deleteCurrentFrameVersion(canvas, path, frame.groupId)));
        }

        menu.addSeparator();
        menu.addItem((item) => item
          .setTitle(frame.layoutPaused ? "Resume layout" : "Pause layout")
          .setIcon(frame.layoutPaused ? "play" : "pause")
          .onClick(() => {
            frame.layoutPaused = !frame.layoutPaused;
            if (frame.layoutPaused) {
              void this.persistState();
              this.decorate(canvas, path);
            } else {
              void this.persistAndReflow(canvas, path, frame);
            }
          }));

        menu.addSeparator();
        menu.addItem((item) => item
          .setTitle(`Decrease gap (${frame.gap}px)`)
          .setIcon("minus")
          .onClick(() => {
            frame.gap = Math.max(0, (Number(frame.gap) || this.defaultGap()) - 8);
            void this.persistAndReflow(canvas, path, frame);
          }));
        menu.addItem((item) => item
          .setTitle(`Increase gap (${frame.gap}px)`)
          .setIcon("plus")
          .onClick(() => {
            frame.gap = Math.min(240, (Number(frame.gap) || this.defaultGap()) + 8);
            void this.persistAndReflow(canvas, path, frame);
          }));
        menu.addItem((item) => item
          .setTitle("Reset gap")
          .setIcon("rotate-ccw")
          .onClick(() => {
            frame.gap = this.defaultGap();
            void this.persistAndReflow(canvas, path, frame);
          }));

        menu.addSeparator();
        menu.addItem((item) => item
          .setTitle(`Decrease padding (${frame.padding}px)`)
          .setIcon("minus")
          .onClick(() => {
            frame.padding = Math.max(0, (Number(frame.padding) || this.defaultPadding()) - 8);
            void this.persistAndReflow(canvas, path, frame);
          }));
        menu.addItem((item) => item
          .setTitle(`Increase padding (${frame.padding}px)`)
          .setIcon("plus")
          .onClick(() => {
            frame.padding = Math.min(240, (Number(frame.padding) || this.defaultPadding()) + 8);
            void this.persistAndReflow(canvas, path, frame);
          }));
        menu.addItem((item) => item
          .setTitle("Reset padding")
          .setIcon("rotate-ccw")
          .onClick(() => {
            frame.padding = this.defaultPadding();
            void this.persistAndReflow(canvas, path, frame);
          }));

        menu.addSeparator();
        menu.addItem((item) => item
          .setTitle(`Decrease nested spacing (${frame.nestedSpacing}px)`)
          .setIcon("minus")
          .onClick(() => {
            frame.nestedSpacing = Math.max(0, (Number(frame.nestedSpacing) || 0) - 8);
            void this.persistAndReflow(canvas, path, frame);
          }));
        menu.addItem((item) => item
          .setTitle(`Increase nested spacing (${frame.nestedSpacing}px)`)
          .setIcon("plus")
          .onClick(() => {
            frame.nestedSpacing = Math.min(240, (Number(frame.nestedSpacing) || 0) + 8);
            void this.persistAndReflow(canvas, path, frame);
          }));
        menu.addItem((item) => item
          .setTitle("Reset nested spacing")
          .setIcon("rotate-ccw")
          .onClick(() => {
            frame.nestedSpacing = this.defaultNestedSpacing();
            void this.persistAndReflow(canvas, path, frame);
          }));

        menu.addItem((item) => item
          .setTitle(`Decrease nested inset (${frame.nestedInset}px)`)
          .setIcon("arrow-left")
          .onClick(() => {
            frame.nestedInset = Math.max(0, (Number(frame.nestedInset) || 0) - 8);
            void this.persistAndReflow(canvas, path, frame);
          }));
        menu.addItem((item) => item
          .setTitle(`Increase nested inset (${frame.nestedInset}px)`)
          .setIcon("arrow-right")
          .onClick(() => {
            frame.nestedInset = Math.min(240, (Number(frame.nestedInset) || 0) + 8);
            void this.persistAndReflow(canvas, path, frame);
          }));
        menu.addItem((item) => item
          .setTitle("Reset nested inset")
          .setIcon("rotate-ccw")
          .onClick(() => {
            frame.nestedInset = this.defaultNestedInset();
            void this.persistAndReflow(canvas, path, frame);
          }));

        menu.addSeparator();
        if (frame.sizeMode === "fixed") {
          menu.addItem((item) => item
            .setTitle("Unlock fixed card sizes")
            .setIcon("unlock")
            .onClick(() => {
              frame.sizeMode = "free";
              frame.fixedSizes = {};
              void this.persistAndReflow(canvas, path, frame);
            }));
        } else {
          menu.addItem((item) => item
            .setTitle("Lock current card sizes")
            .setIcon("lock")
            .onClick(() => {
              frame.sizeMode = "fixed";
              frame.fixedSizes = {};
              for (const childId of frame.children) {
                const child = this.liveNodeData(canvas, childId);
                if (child) {
                  frame.fixedSizes[childId] = {
                    width: child.width,
                    height: child.height
                  };
                }
              }
              void this.persistAndReflow(canvas, path, frame);
            }));
        }

        menu.addItem((item) => item
          .setTitle("Stop managing this layout frame")
          .setIcon("unlink")
          .onClick(() => void this.stopManagingFrame(canvas, path, frame)));
      }
    }));

    // Small selection popup around selected Canvas elements.
    // Frame controls are assembled by injectPopupToolbar so Settings can
    // deterministically decide what is visible. This event only contributes
    // layout-creation entry points for ordinary selected cards.
    this.registerEvent(this.app.workspace.on("canvas:selection-menu", (menu, canvas) => {
      const context = this.canvasContext(canvas);
      if (!context) return;

      const path = context.path;
      const selected = this.selectedNonGroupNodes(canvas);

      if (
        selected.length &&
        this.settings.toolbar.createFrameButtons
      ) {
        menu.addItem((item) => item
          .setTitle("Vertical layout")
          .setIcon("rows-3")
          .onClick(() => void this.createFrame(canvas, path, "vertical", selected)));

        menu.addItem((item) => item
          .setTitle("Horizontal layout")
          .setIcon("columns-3")
          .onClick(() => void this.createFrame(canvas, path, "horizontal", selected)));
      }
    }));
  }

  canvasViewPath(view) {
    return (
      view &&
      view.file &&
      typeof view.file.path === "string" &&
      view.file.path
    )
      ? view.file.path
      : null;
  }

  canvasContext(canvas = null) {
    // If a Canvas instance was supplied by a Canvas event, resolve the owning view
    // directly instead of requiring it to already be recognized as the active view.
    if (canvas) {
      const directView = canvas.view || canvas.ownerView || null;
      if (
        directView &&
        directView.file &&
        directView.file.path &&
        directView.canvas === canvas
      ) {
        return {
          view: directView,
          canvas,
          path: directView.file.path
        };
      }

      if (typeof this.app.workspace.getLeavesOfType === "function") {
        const leaves = this.app.workspace.getLeavesOfType("canvas") || [];
        for (const leaf of leaves) {
          const view = leaf && leaf.view;
          if (
            view &&
            view.canvas === canvas &&
            view.file &&
            view.file.path
          ) {
            return {
              view,
              canvas,
              path: view.file.path
            };
          }
        }
      }
    }

    const leaf = this.app.workspace.activeLeaf;
    const view = leaf && leaf.view;

    if (
      view &&
      typeof view.getViewType === "function" &&
      view.getViewType() === "canvas" &&
      view.canvas &&
      view.file &&
      view.file.path
    ) {
      return {
        view,
        canvas: view.canvas,
        path: view.file.path
      };
    }

    // Fallback for Obsidian builds where activeLeaf is temporarily unavailable.
    const generic = this.app.workspace.getActiveViewOfType(ItemView);
    if (
      generic &&
      typeof generic.getViewType === "function" &&
      generic.getViewType() === "canvas" &&
      generic.canvas &&
      generic.file &&
      generic.file.path
    ) {
      return {
        view: generic,
        canvas: generic.canvas,
        path: generic.file.path
      };
    }

    return null;
  }

  activeCanvasView() {
    const context = this.canvasContext();
    return context ? context.view : null;
  }

  withCanvas(fn) {
    const context = this.canvasContext();
    if (!context) return false;
    return fn(context.canvas, context.path);
  }

  repairBackupsForPath(path) {
    return (this.state.repairBackups || [])
      .filter((backup) => backup && backup.path === path)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  missingNoteVersionEntries(path) {
    const state = this.canvasState(path, false);
    if (!state || !state.noteVersions) return [];

    const result = [];

    for (const [nodeId, noteState] of Object.entries(state.noteVersions)) {
      if (!noteState || !Array.isArray(noteState.versions)) continue;

      noteState.versions.forEach((version, index) => {
        if (!version || typeof version.file !== "string" || !version.file) {
          result.push({
            nodeId,
            index,
            version,
            reason: "missing-path"
          });
          return;
        }

        const file = this.app.vault.getAbstractFileByPath(version.file);

        if (!file) {
          result.push({
            nodeId,
            index,
            version,
            reason: "file-not-found"
          });
        }
      });
    }

    return result;
  }

  openRelinkNoteVersionPicker(canvas, path, nodeId, versionIndex, onDone = null) {
    const state = this.canvasState(path, false);
    const noteState =
      state &&
      state.noteVersions &&
      state.noteVersions[nodeId];

    if (
      !noteState ||
      !noteState.versions ||
      !noteState.versions[versionIndex]
    ) {
      new Notice("Note Version no longer exists.");
      return;
    }

    const plugin = this;

    class RelinkNoteVersionPicker extends FuzzySuggestModal {
      getItems() {
        return plugin.app.vault.getMarkdownFiles();
      }

      getItemText(file) {
        return file.path;
      }

      async onChooseItem(file) {
        const currentState = plugin.canvasState(path, false);
        const currentNoteState =
          currentState &&
          currentState.noteVersions &&
          currentState.noteVersions[nodeId];

        if (
          !currentNoteState ||
          !currentNoteState.versions ||
          !currentNoteState.versions[versionIndex]
        ) {
          new Notice("Note Version no longer exists.");
          return;
        }

        const duplicateIndex = currentNoteState.versions.findIndex(
          (version, index) =>
            index !== versionIndex &&
            version &&
            version.file === file.path
        );

        if (duplicateIndex >= 0) {
          new Notice(
            `That note is already Version ${duplicateIndex + 1} in this set.`
          );
          return;
        }

        currentNoteState.versions[versionIndex].file = file.path;

        await plugin.persistState();

        if (currentNoteState.active === versionIndex) {
          await plugin.applyActiveNoteVersion(
            canvas,
            path,
            nodeId
          );
        } else {
          plugin.decorate(canvas, path);
        }

        new Notice(`Relinked Note Version ${versionIndex + 1}.`);

        if (typeof onDone === "function") {
          onDone();
        }
      }
    }

    const modal = new RelinkNoteVersionPicker(this.app);
    modal.setPlaceholder("Choose replacement Markdown note");
    modal.open();
  }

  openBrokenNoteVersionOverview(canvas, path) {
    const plugin = this;

    class BrokenNoteVersionModal extends Modal {
      onOpen() {
        this.modalEl.addClass("story-version-overview-modal");
        this.render();
      }

      render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("story-version-overview");

        const broken = plugin.missingNoteVersionEntries(path);

        const header = contentEl.createDiv({
          cls: "story-version-overview-header"
        });

        header.createEl("h2", {
          text: "Broken Note Versions"
        });

        header.createDiv({
          cls: "story-version-overview-count",
          text: broken.length
            ? `${broken.length} broken references`
            : "No broken references"
        });

        if (!broken.length) {
          contentEl.createDiv({
            cls: "story-repair-empty",
            text: "All Note Version file paths currently resolve."
          });
          return;
        }

        const list = contentEl.createDiv({
          cls: "story-version-overview-list"
        });

        for (const entry of broken) {
          const state = plugin.canvasState(path, false);
          const noteState =
            state &&
            state.noteVersions &&
            state.noteVersions[entry.nodeId];

          if (!noteState) continue;

          const version = noteState.versions[entry.index];

          const row = list.createDiv({
            cls: "story-version-overview-item story-repair-broken-item"
          });

          const meta = row.createDiv({
            cls: "story-version-overview-meta"
          });

          const titleWrap = meta.createDiv({
            cls: "story-version-overview-title-wrap"
          });

          titleWrap.createSpan({
            cls: "story-version-overview-number",
            text: plugin.versionDisplayName(
              version,
              entry.index
            )
          });

          if (noteState.active === entry.index) {
            titleWrap.createSpan({
              cls: "story-version-overview-active",
              text: "Current"
            });
          }

          const relink = meta.createEl("button", {
            text: "Relink",
            cls: "mod-cta"
          });

          relink.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();

            plugin.openRelinkNoteVersionPicker(
              canvas,
              path,
              entry.nodeId,
              entry.index,
              () => this.render()
            );
          });

          row.createDiv({
            cls: "story-repair-broken-path",
            text:
              version && version.file
                ? version.file
                : "(no saved path)"
          });

          row.createDiv({
            cls: "story-version-overview-preview",
            text:
              entry.reason === "missing-path"
                ? "The version has no Markdown path."
                : "The saved Markdown path no longer exists in this Vault."
          });
        }
      }

      onClose() {
        this.modalEl.removeClass("story-version-overview-modal");
        this.contentEl.empty();
      }
    }

    new BrokenNoteVersionModal(this.app).open();
  }

  openRepairBackupRestoreModal(canvas, path) {
    const backups = this.repairBackupsForPath(path);
    if (!backups.length) {
      new Notice("No repair backups exist for this Canvas.");
      return;
    }

    const plugin = this;

    class RepairBackupModal extends Modal {
      onOpen() {
        this.modalEl.addClass("story-version-overview-modal");
        this.render();
      }

      render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("story-version-overview");

        const currentBackups = plugin.repairBackupsForPath(path);

        const header = contentEl.createDiv({
          cls: "story-version-overview-header"
        });

        header.createEl("h2", {
          text: "Repair backups"
        });

        header.createDiv({
          cls: "story-version-overview-count",
          text: `${currentBackups.length} backups`
        });

        const warning = contentEl.createDiv({
          cls: "story-repair-warning",
          text:
            "Restore replaces Story Canvas Layout state for this Canvas only. It does not modify Canvas nodes or Markdown files."
        });

        const list = contentEl.createDiv({
          cls: "story-version-overview-list"
        });

        currentBackups.forEach((backup, index) => {
          const row = list.createDiv({
            cls: "story-version-overview-item"
          });

          const meta = row.createDiv({
            cls: "story-version-overview-meta"
          });

          const titleWrap = meta.createDiv({
            cls: "story-version-overview-title-wrap"
          });

          const date = new Date(backup.createdAt || 0);

          titleWrap.createSpan({
            cls: "story-version-overview-number",
            text: `Backup ${index + 1}`
          });

          titleWrap.createSpan({
            cls: "story-repair-reason",
            text: backup.reason || "repair"
          });

          const restore = meta.createEl("button", {
            text: "Restore",
            cls: "mod-cta"
          });

          restore.addEventListener("click", async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();

            // Preserve the current state as a backup first, so restore itself
            // is reversible.
            const currentState = plugin.canvasState(path, false);

            if (currentState) {
              plugin.pushRepairBackup(
                path,
                currentState,
                "before-backup-restore"
              );
            }

            plugin.state.canvases[path] =
              clone(backup.state);

            await plugin.persistState();

            plugin.nodeGeometry.clear();
            plugin.frameRelativeGeometry.clear();

            plugin.updateFrameVersionVisibility(
              canvas,
              path
            );

            plugin.refreshAllFrameRelativeGeometry(
              canvas,
              path
            );

            plugin.decorate(canvas, path);
            plugin.queuePrepareActiveCanvas();

            new Notice("Repair backup restored.");
            this.close();
          });

          row.createDiv({
            cls: "story-repair-backup-date",
            text: date.toLocaleString()
          });
        });
      }

      onClose() {
        this.modalEl.removeClass("story-version-overview-modal");
        this.contentEl.empty();
      }
    }

    new RepairBackupModal(this.app).open();
  }

  pushRepairBackup(path, canvasState, reason = "repair") {
    if (!canvasState) return;

    if (!Array.isArray(this.state.repairBackups)) {
      this.state.repairBackups = [];
    }

    this.state.repairBackups.push({
      id: uid(),
      path,
      reason,
      createdAt: Date.now(),
      state: clone(canvasState)
    });

    // Keep the data file bounded. Ten repair snapshots are enough to undo a
    // recent automatic cleanup without growing forever.
    if (this.state.repairBackups.length > 10) {
      this.state.repairBackups.splice(
        0,
        this.state.repairBackups.length - 10
      );
    }
  }

  uniqueExistingNodeIds(canvas, ids, excludeId = null) {
    if (!Array.isArray(ids) || !canvas.nodes) return [];

    const result = [];
    const seen = new Set();

    for (const id of ids) {
      if (
        typeof id !== "string" ||
        id === excludeId ||
        seen.has(id) ||
        !canvas.nodes.has(id)
      ) {
        continue;
      }

      seen.add(id);
      result.push(id);
    }

    return result;
  }

  frameGraphWouldCycle(frames, parentId, childId) {
    if (parentId === childId) return true;
    if (!frames || !frames[childId]) return false;

    const visited = new Set();

    const visit = (id) => {
      if (id === parentId) return true;
      if (visited.has(id)) return false;
      visited.add(id);

      const frame = frames[id];
      if (!frame) return false;

      for (const nestedId of frame.children || []) {
        if (frames[nestedId] && visit(nestedId)) {
          return true;
        }
      }

      return false;
    };

    return visit(childId);
  }

  repairSummaryText(report) {
    const parts = [];

    if (report.framesRemoved) {
      parts.push(`${report.framesRemoved} dead frame`);
    }
    if (report.childRefsRemoved) {
      parts.push(`${report.childRefsRemoved} dead/duplicate child ref`);
    }
    if (report.duplicateMembershipsRemoved) {
      parts.push(`${report.duplicateMembershipsRemoved} duplicate membership`);
    }
    if (report.cyclesRemoved) {
      parts.push(`${report.cyclesRemoved} nested cycle`);
    }
    if (report.cardHistoriesRemoved) {
      parts.push(`${report.cardHistoriesRemoved} orphan text history`);
    }
    if (report.noteHistoriesRemoved) {
      parts.push(`${report.noteHistoriesRemoved} orphan note history`);
    }
    if (report.frameHistoriesRemoved) {
      parts.push(`${report.frameHistoriesRemoved} orphan frame history`);
    }
    if (report.versionRefsRemoved) {
      parts.push(`${report.versionRefsRemoved} dead version ref`);
    }
    if (report.activeIndexesFixed) {
      parts.push(`${report.activeIndexesFixed} active index`);
    }

    return parts.length ? parts.join(", ") : "no changes";
  }

  async repairCanvasState(canvas, path, options = {}) {
    const notify = !!options.notify;
    const reason = options.reason || "repair";
    const state = this.canvasState(path, false);

    if (!state || !canvas || !canvas.nodes) {
      if (notify) new Notice("No Story Canvas Layout state to repair.");
      return null;
    }

    const report = {
      changed: false,
      framesRemoved: 0,
      childRefsRemoved: 0,
      duplicateMembershipsRemoved: 0,
      cyclesRemoved: 0,
      cardHistoriesRemoved: 0,
      noteHistoriesRemoved: 0,
      frameHistoriesRemoved: 0,
      versionRefsRemoved: 0,
      activeIndexesFixed: 0
    };

    // Snapshot only if we actually discover damage. We hold a cheap clone here
    // and push it after report.changed becomes true.
    const before = clone(state);

    // ---- Managed Frames ----
    for (const [groupId, frame] of Object.entries(state.frames || {})) {
      const node = canvas.nodes.get(groupId);
      const data =
        node && typeof node.getData === "function"
          ? node.getData()
          : null;

      if (!data || data.type !== "group") {
        delete state.frames[groupId];
        report.framesRemoved += 1;
        report.changed = true;
        continue;
      }

      const oldChildren = Array.isArray(frame.children)
        ? frame.children
        : [];

      const repairedChildren =
        this.uniqueExistingNodeIds(canvas, oldChildren, groupId);

      report.childRefsRemoved +=
        Math.max(0, oldChildren.length - repairedChildren.length);

      frame.children = repairedChildren;

      if (oldChildren.length !== repairedChildren.length) {
        report.changed = true;
      }

      if (!frame.fixedSizes || typeof frame.fixedSizes !== "object") {
        frame.fixedSizes = {};
        report.changed = true;
      }

      for (const fixedId of Object.keys(frame.fixedSizes)) {
        if (!frame.children.includes(fixedId)) {
          delete frame.fixedSizes[fixedId];
          report.changed = true;
        }
      }
    }

    // One active child belongs to at most one managed Frame. Keep the first
    // membership in state iteration order; remove later duplicates.
    const owner = new Map();

    for (const frame of Object.values(state.frames || {})) {
      const nextChildren = [];

      for (const childId of frame.children || []) {
        if (owner.has(childId)) {
          report.duplicateMembershipsRemoved += 1;
          report.changed = true;
          continue;
        }

        owner.set(childId, frame.groupId);
        nextChildren.push(childId);
      }

      frame.children = nextChildren;
    }

    // Remove impossible nested cycles. Test after duplicate-membership cleanup.
    for (const frame of Object.values(state.frames || {})) {
      const nextChildren = [];

      for (const childId of frame.children || []) {
        if (
          state.frames[childId] &&
          this.frameGraphWouldCycle(
            state.frames,
            frame.groupId,
            childId
          )
        ) {
          report.cyclesRemoved += 1;
          report.changed = true;
          continue;
        }

        nextChildren.push(childId);
      }

      frame.children = nextChildren;
    }

    // ---- Text Card Versions ----
    for (const [nodeId, versionState] of Object.entries(state.cardVersions || {})) {
      const node = canvas.nodes.get(nodeId);
      const data =
        node && typeof node.getData === "function"
          ? node.getData()
          : null;

      if (!data || data.type !== "text") {
        delete state.cardVersions[nodeId];
        report.cardHistoriesRemoved += 1;
        report.changed = true;
        continue;
      }

      if (!Array.isArray(versionState.versions) || !versionState.versions.length) {
        delete state.cardVersions[nodeId];
        report.cardHistoriesRemoved += 1;
        report.changed = true;
        continue;
      }

      const oldActive = Number(versionState.active) || 0;
      versionState.active = Math.max(
        0,
        Math.min(oldActive, versionState.versions.length - 1)
      );

      if (versionState.active !== oldActive) {
        report.activeIndexesFixed += 1;
        report.changed = true;
      }
    }

    // ---- Markdown Note Versions ----
    // Missing Markdown files are intentionally NOT deleted here. The path may
    // be repairable later and losing version metadata would make recovery worse.
    for (const [nodeId, versionState] of Object.entries(state.noteVersions || {})) {
      const node = canvas.nodes.get(nodeId);
      const data =
        node && typeof node.getData === "function"
          ? node.getData()
          : null;

      if (!data || data.type !== "file") {
        delete state.noteVersions[nodeId];
        report.noteHistoriesRemoved += 1;
        report.changed = true;
        continue;
      }

      if (!Array.isArray(versionState.versions) || !versionState.versions.length) {
        delete state.noteVersions[nodeId];
        report.noteHistoriesRemoved += 1;
        report.changed = true;
        continue;
      }

      const oldActive = Number(versionState.active) || 0;
      versionState.active = Math.max(
        0,
        Math.min(oldActive, versionState.versions.length - 1)
      );

      if (versionState.active !== oldActive) {
        report.activeIndexesFixed += 1;
        report.changed = true;
      }
    }

    // ---- Frame Versions ----
    for (const [groupId, versionState] of Object.entries(state.frameVersions || {})) {
      if (!state.frames[groupId]) {
        delete state.frameVersions[groupId];
        report.frameHistoriesRemoved += 1;
        report.changed = true;
        continue;
      }

      if (!Array.isArray(versionState.versions) || !versionState.versions.length) {
        delete state.frameVersions[groupId];
        report.frameHistoriesRemoved += 1;
        report.changed = true;
        continue;
      }

      for (const version of versionState.versions) {
        const beforeChildren = Array.isArray(version.children)
          ? version.children
          : [];

        const afterChildren =
          this.uniqueExistingNodeIds(
            canvas,
            beforeChildren,
            groupId
          );

        const removed =
          Math.max(0, beforeChildren.length - afterChildren.length);

        if (removed) {
          report.versionRefsRemoved += removed;
          report.changed = true;
        }

        version.children = afterChildren;
      }

      const oldActive = Number(versionState.active) || 0;
      versionState.active = Math.max(
        0,
        Math.min(oldActive, versionState.versions.length - 1)
      );

      if (versionState.active !== oldActive) {
        report.activeIndexesFixed += 1;
        report.changed = true;
      }

      const validRefs = this.frameVersionUnionChildren(versionState);
      versionState.visibleDetached =
        (versionState.visibleDetached || [])
          .filter((id) => canvas.nodes.has(id) && validRefs.has(id));
    }

    // Make the active frame-version snapshot agree with the actual current
    // managed Frame after cleanup. This preserves what the user currently sees.
    for (const [groupId, versionState] of Object.entries(state.frameVersions || {})) {
      const frame = state.frames[groupId];
      if (!frame || !versionState.versions.length) continue;

      const active = versionState.versions[versionState.active];
      if (!active) continue;

      active.children = [...frame.children];
      active.direction = frame.direction || "vertical";
      active.gap = Number.isFinite(frame.gap) ? frame.gap : DEFAULT_GAP;
      active.padding = Number.isFinite(frame.padding) ? frame.padding : DEFAULT_PADDING;
      active.nestedSpacing = Number.isFinite(frame.nestedSpacing) ? frame.nestedSpacing : 16;
      active.nestedInset = Number.isFinite(frame.nestedInset) ? frame.nestedInset : 20;
      active.layoutPaused = !!frame.layoutPaused;
    }

    if (!report.changed) {
      if (notify) {
        new Notice("Canvas state is healthy. No repair needed.");
      }
      return report;
    }

    this.pushRepairBackup(path, before, reason);
    await this.persistState();

    this.updateFrameVersionVisibility(canvas, path);
    this.refreshAllFrameRelativeGeometry(canvas, path);
    this.decorate(canvas, path);

    if (notify) {
      new Notice(
        `Canvas state repaired: ${this.repairSummaryText(report)}.`
      );
    }

    console.info(
      "[Story Canvas Layout] Canvas state repaired",
      path,
      report
    );

    return report;
  }

  canvasState(path, create = true) {
    let result = this.state.canvases[path];
    if (!result && create) {
      result = {
        schemaVersion: 2,
        frames: {},
        cardVersions: {},
        noteVersions: {},
        frameVersions: {}
      };
      this.state.canvases[path] = result;
    }

    if (result) {
      if (!Number.isFinite(result.schemaVersion)) {
        result.schemaVersion = 2;
      }
      if (!result.frames) result.frames = {};
      if (!result.cardVersions) result.cardVersions = {};
      if (!result.noteVersions) result.noteVersions = {};
      if (!result.frameVersions) result.frameVersions = {};

      for (const frame of Object.values(result.frames)) {
        if (!frame.sizeMode || frame.sizeMode === "manual" || frame.sizeMode === "auto") {
          frame.sizeMode = "free";
        }
        if (!frame.fixedSizes) {
          frame.fixedSizes = {};
        }
        if (!Number.isFinite(frame.padding)) {
          frame.padding = this.defaultPadding();
        }
        if (!Number.isFinite(frame.gap)) {
          frame.gap = this.defaultGap();
        }
        if (typeof frame.layoutPaused !== "boolean") {
          frame.layoutPaused = false;
        }
        if (!Number.isFinite(frame.nestedSpacing)) {
          frame.nestedSpacing = this.defaultNestedSpacing();
        }
        if (!Number.isFinite(frame.nestedInset)) {
          frame.nestedInset = this.defaultNestedInset();
        }
      }
    }

    return result;
  }

  selectedNonGroupNodes(canvas) {
    if (!canvas.selection) return [];
    return [...canvas.selection]
      .map((node) => node.getData())
      .filter((node) => node && node.type !== "group");
  }

  selectedManagedFrame(canvas, path) {
    const state = this.canvasState(path, false);
    if (!state || !canvas.selection) return null;
    for (const node of canvas.selection) {
      if (state.frames[node.id]) return state.frames[node.id];
    }
    return null;
  }

  frameForNodeId(path, nodeId) {
    const state = this.canvasState(path, false);
    if (!state) return null;
    if (state.frames[nodeId]) return state.frames[nodeId];
    for (const frame of Object.values(state.frames)) {
      if (frame.children.includes(nodeId)) return frame;
    }
    return null;
  }

  invalidateCanvasRuntimeForPathMove(
    oldPath,
    newPath
  ) {
    // Any pointer/geometry/popup callback created before the move captured
    // oldPath in its closure. Updating only boundCanvasPath/geometryPath leaves
    // those callbacks permanently comparing NEW runtime state against OLD path.
    //
    // Tear them down completely and let prepareActiveCanvas recreate them with
    // the new canonical full Vault path.
    const activeWasMoved =
      this.boundCanvasPath === oldPath ||
      this.geometryPath === oldPath;

    if (activeWasMoved) {
      this.detachPointerListeners();

      if (this.geometryTimer) {
        window.clearInterval(this.geometryTimer);
      }

      this.geometryTimer = null;
      this.geometryCanvas = null;
      this.geometryPath = null;

      this.detachPopupObserver();
      this.clearIndicator();

      this.boundCanvas = null;
      this.boundCanvasPath = null;
      this.boundCanvasHost = null;
    }

    // Geometry caches are path-keyed. Clearing is safer than re-keying stale
    // baselines across a move because the next prepare rebuilds them from live
    // Canvas geometry.
    for (const key of [...this.nodeGeometry.keys()]) {
      if (
        key.startsWith(`${oldPath}::`) ||
        key.startsWith(`${newPath}::`)
      ) {
        this.nodeGeometry.delete(key);
      }
    }

    for (const key of [...this.frameRelativeGeometry.keys()]) {
      if (
        key.startsWith(`${oldPath}::`) ||
        key.startsWith(`${newPath}::`)
      ) {
        this.frameRelativeGeometry.delete(key);
      }
    }

    this.frameVersionHiddenNodes.delete(oldPath);
    this.frameVersionHiddenNodes.delete(newPath);

    this.geometryIgnoreUntil.delete(oldPath);
    this.geometryIgnoreUntil.delete(newPath);

    this.canvasNodeIdSnapshots.delete(oldPath);
    this.canvasNodeIdSnapshots.delete(newPath);

    // Old generic Canvas bindings also contain callbacks/state associated with
    // oldPath. Remove rather than mutate them in place.
    for (const [key, binding] of [...this.canvasBindings.entries()]) {
      if (
        !binding ||
        (
          binding.path !== oldPath &&
          binding.path !== newPath
        )
      ) {
        continue;
      }

      if (binding.popupObserver) {
        try {
          binding.popupObserver.disconnect();
        } catch (_) {}
      }

      this.canvasBindings.delete(key);
    }

    // Any delayed prepare created before the move may still reference oldPath.
    // Cancel all pending prepares; queue a fresh multi-stage prepare below.
    for (const timer of this.prepareTimers) {
      window.clearTimeout(timer);
    }
    this.prepareTimers.clear();

    for (const timer of this.canvasPrepareTimers) {
      window.clearTimeout(timer);
    }
    this.canvasPrepareTimers.clear();
  }

  async handleVaultFileRename(file, oldPath) {
    if (!file || typeof file.path !== "string" || !oldPath || file.path === oldPath) return;

    let changed = false;

    const isCanvasMove =
      String(file.path)
        .toLowerCase()
        .endsWith(".canvas");

    // Canvas plugin state is keyed by Canvas file path. If the .canvas file is
    // renamed or moved inside Obsidian, move the entire state bucket with it.
    if (
      isCanvasMove &&
      this.state.canvases &&
      this.state.canvases[oldPath]
    ) {
      if (!this.state.canvases[file.path]) {
        this.state.canvases[file.path] = this.state.canvases[oldPath];
      } else {
        // Extremely unusual collision: preserve both states in repair backups
        // instead of silently overwriting the destination.
        this.pushRepairBackup(
          oldPath,
          this.state.canvases[oldPath],
          "canvas-rename-collision"
        );
      }

      delete this.state.canvases[oldPath];
      changed = true;

    }

    if (isCanvasMove) {
      // Runtime listeners/timers are path-bound even if plugin data.json did
      // not contain an old state bucket (for example marker-only recovery).
      this.invalidateCanvasRuntimeForPathMove(
        oldPath,
        file.path
      );
    }

    for (const canvasState of Object.values(this.state.canvases || {})) {
      if (!canvasState || !canvasState.noteVersions) continue;

      for (const noteState of Object.values(canvasState.noteVersions)) {
        if (!noteState || !noteState.versions) continue;

        for (const version of noteState.versions) {
          if (version.file === oldPath) {
            version.file = file.path;
            changed = true;
          }
        }
      }
    }

    if (changed) {
      await this.persistState();
    }

    if (isCanvasMove) {
      // Wait for Obsidian's file/view path update to settle, then rebuild every
      // path-capturing listener against view.file.path.
      this.queuePrepareAllCanvases();

      window.setTimeout(
        () => this.queuePrepareAllCanvases(),
        120
      );

      window.setTimeout(
        () => this.queuePrepareAllCanvases(),
        420
      );

      new Notice(
        `Story Canvas Layout rebound moved Canvas: ${file.path}`
      );
    } else if (changed) {
      new Notice(
        `Updated note version path: ${file.path}`
      );
    }
  }

  normalizeMarkdownPath(input) {
    let path = String(input || "").trim().replace(/^\/+/, "");
    if (!path) return "";
    if (!path.toLowerCase().endsWith(".md")) path += ".md";
    return path;
  }

  async ensureFolderPathForFile(filePath) {
    const parts = String(filePath || "").split("/").filter(Boolean);
    if (parts.length <= 1) return;

    parts.pop();
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch (_) {}
      }
    }
  }

  async addExistingNoteVersion(canvas, path, nodeId, filePath) {
    let noteState = await this.initializeNoteVersionState(canvas, path, nodeId);
    if (!noteState) {
      new Notice("Could not initialize note version history.");
      return;
    }

    noteState = this.syncActiveNoteVersion(canvas, path, nodeId) || noteState;

    if (noteState.versions.some((version) => version.file === filePath)) {
      new Notice("That note is already in this version set.");
      return;
    }

    const currentNode = this.liveNodeData(canvas, nodeId);

    noteState.versions.splice(noteState.active + 1, 0, {
      id: uid(),
      file: filePath,
      label: "",
      width: currentNode ? Number(currentNode.width) || null : null,
      height: currentNode ? Number(currentNode.height) || null : null,
      managed: false
    });

    noteState.active += 1;
    await this.persistState();
    await this.applyActiveNoteVersion(canvas, path, nodeId);
    new Notice(`Added note version ${noteState.active + 1}/${noteState.versions.length}`);
  }

  openAddExistingNoteVersionPicker(canvas, path, nodeId) {
    const plugin = this;

    class NoteVersionPicker extends FuzzySuggestModal {
      getItems() {
        return plugin.app.vault.getMarkdownFiles();
      }

      getItemText(file) {
        return file.path;
      }

      onChooseItem(file) {
        void plugin.addExistingNoteVersion(canvas, path, nodeId, file.path);
      }
    }

    const modal = new NoteVersionPicker(this.app);
    modal.setPlaceholder("Choose an existing Markdown note");
    modal.open();
  }

  openCreateBlankNoteVersionModal(canvas, path, nodeId) {
    const nodeData = this.liveNodeData(canvas, nodeId);
    const currentPath =
      nodeData && nodeData.type === "file" && typeof nodeData.file === "string"
        ? nodeData.file
        : "";

    const sourceFolder = currentPath.includes("/")
      ? currentPath.slice(0, currentPath.lastIndexOf("/"))
      : "";

    const sourceName = currentPath
      ? currentPath.split("/").pop().replace(/\.md$/i, "")
      : "New version";

    const defaultPath =
      `${sourceFolder ? `${sourceFolder}/` : ""}${sourceName} - version.md`;

    const plugin = this;

    class CreateBlankNoteVersionModal extends Modal {
      onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "Create blank note version" });

        contentEl.createDiv({
          cls: "story-version-rename-help",
          text: "Enter any Vault path. You can move or rename the note later; Story Canvas Layout will track Vault rename/move events."
        });

        const inputWrap = contentEl.createDiv({ cls: "story-version-rename-input" });
        const input = new TextComponent(inputWrap);
        input.setValue(defaultPath);
        input.inputEl.placeholder = "Folder/Subfolder/Note name.md";
        input.inputEl.focus();
        input.inputEl.select();

        const actions = contentEl.createDiv({ cls: "story-version-rename-actions" });
        const cancel = actions.createEl("button", { text: "Cancel" });
        cancel.addEventListener("click", () => this.close());

        const create = actions.createEl("button", { text: "Create", cls: "mod-cta" });

        const commit = async () => {
          const targetPath = plugin.normalizeMarkdownPath(input.getValue());
          if (!targetPath) {
            new Notice("Please enter a note path.");
            return;
          }

          if (plugin.app.vault.getAbstractFileByPath(targetPath)) {
            new Notice("A file already exists at that path.");
            return;
          }

          await plugin.ensureFolderPathForFile(targetPath);
          await plugin.app.vault.create(targetPath, "");
          await plugin.addExistingNoteVersion(canvas, path, nodeId, targetPath);
          this.close();
        };

        create.addEventListener("click", () => void commit());
        input.inputEl.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            void commit();
          }
        });
      }

      onClose() {
        this.contentEl.empty();
      }
    }

    new CreateBlankNoteVersionModal(this.app).open();
  }

  async ensureNoteVersionFolder() {
    const folder = "Story Canvas Versions";
    const existing = this.app.vault.getAbstractFileByPath(folder);
    if (!existing) {
      try {
        await this.app.vault.createFolder(folder);
      } catch (_) {}
    }
    return folder;
  }

  safeVersionFilename(sourcePath, nodeId, versionNumber) {
    const sourceName = String(sourcePath || "note.md")
      .split("/")
      .pop()
      .replace(/\.md$/i, "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .trim() || "note";

    return `${sourceName} — ${nodeId.slice(0, 6)} — v${versionNumber}.md`;
  }

  async readVaultText(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || typeof file.extension !== "string" || file.extension !== "md") {
      return "";
    }
    try {
      return await this.app.vault.read(file);
    } catch (_) {
      return "";
    }
  }

  async createManagedNoteVersionFile(sourcePath, nodeId, versionNumber, content) {
    const folder = await this.ensureNoteVersionFolder();
    let base = `${folder}/${this.safeVersionFilename(sourcePath, nodeId, versionNumber)}`;
    let path = base;
    let suffix = 2;

    while (this.app.vault.getAbstractFileByPath(path)) {
      path = base.replace(/\.md$/i, ` (${suffix}).md`);
      suffix += 1;
    }

    await this.app.vault.create(path, String(content || ""));
    return path;
  }

  getNoteVersionState(path, nodeId, create = false) {
    const state = this.canvasState(path, create);
    if (!state) return null;
    if (!state.noteVersions) state.noteVersions = {};

    const existing = state.noteVersions[nodeId];
    return existing || null;
  }

  async initializeNoteVersionState(canvas, path, nodeId) {
    let noteState = this.getNoteVersionState(path, nodeId, false);
    if (noteState) return noteState;

    const nodeData = this.liveNodeData(canvas, nodeId);
    if (!nodeData || nodeData.type !== "file" || typeof nodeData.file !== "string") return null;

    noteState = {
      active: 0,
      versions: [{
        id: uid(),
        file: nodeData.file,
        label: "",
        width: Number(nodeData.width) || null,
        height: Number(nodeData.height) || null,
        managed: false
      }]
    };

    const state = this.canvasState(path, true);
    state.noteVersions[nodeId] = noteState;
    await this.persistState();
    return noteState;
  }

  syncActiveNoteVersion(canvas, path, nodeId) {
    const noteState = this.getNoteVersionState(path, nodeId, false);
    if (!noteState || !noteState.versions.length) return noteState;

    const nodeData = this.liveNodeData(canvas, nodeId);
    if (!nodeData || nodeData.type !== "file") return noteState;

    noteState.active = Math.max(0, Math.min(noteState.active, noteState.versions.length - 1));
    const version = noteState.versions[noteState.active];
    if (version) {
      version.width = Number(nodeData.width) || version.width || null;
      version.height = Number(nodeData.height) || version.height || null;
      if (typeof version.label !== "string") version.label = "";
    }
    return noteState;
  }

  async applyActiveNoteVersion(canvas, path, nodeId) {
    const noteState = this.getNoteVersionState(path, nodeId, false);
    if (!noteState || !noteState.versions.length) return false;

    noteState.active = Math.max(0, Math.min(noteState.active, noteState.versions.length - 1));
    const version = noteState.versions[noteState.active];
    const patch = { file: version.file };

    if (Number.isFinite(version.width)) patch.width = version.width;
    if (Number.isFinite(version.height)) patch.height = version.height;

    this.patchLiveNode(canvas, nodeId, patch);
    this.reflowParentChain(canvas, path, nodeId);
    canvas.requestSave(false);
    this.decorate(canvas, path);
    window.setTimeout(() => this.injectPopupToolbar(canvas, path), 0);
    return true;
  }

  async duplicateNoteVersion(canvas, path, nodeId) {
    let noteState = await this.initializeNoteVersionState(canvas, path, nodeId);
    if (!noteState) {
      new Notice("Could not initialize note version history.");
      return;
    }

    noteState = this.syncActiveNoteVersion(canvas, path, nodeId) || noteState;
    const current = noteState.versions[noteState.active];
    const content = await this.readVaultText(current.file);

    const newPath = await this.createManagedNoteVersionFile(
      current.file,
      nodeId,
      noteState.versions.length + 1,
      content
    );

    noteState.versions.splice(noteState.active + 1, 0, {
      id: uid(),
      file: newPath,
      label: "",
      width: Number.isFinite(current.width) ? current.width : null,
      height: Number.isFinite(current.height) ? current.height : null,
      managed: true
    });
    noteState.active += 1;

    await this.persistState();
    await this.applyActiveNoteVersion(canvas, path, nodeId);
    new Notice(`Note version ${noteState.active + 1}/${noteState.versions.length}`);
  }

  async newBlankNoteVersion(canvas, path, nodeId) {
    let noteState = await this.initializeNoteVersionState(canvas, path, nodeId);
    if (!noteState) {
      new Notice("Could not initialize note version history.");
      return;
    }

    noteState = this.syncActiveNoteVersion(canvas, path, nodeId) || noteState;
    const current = noteState.versions[noteState.active];

    const newPath = await this.createManagedNoteVersionFile(
      current.file,
      nodeId,
      noteState.versions.length + 1,
      ""
    );

    noteState.versions.splice(noteState.active + 1, 0, {
      id: uid(),
      file: newPath,
      label: "",
      width: Number.isFinite(current.width) ? current.width : null,
      height: Number.isFinite(current.height) ? current.height : null,
      managed: true
    });
    noteState.active += 1;

    await this.persistState();
    await this.applyActiveNoteVersion(canvas, path, nodeId);
    new Notice(`Blank note version ${noteState.active + 1}/${noteState.versions.length}`);
  }

  async switchNoteVersion(canvas, path, nodeId, delta) {
    let noteState = this.getNoteVersionState(path, nodeId, false);
    if (!noteState || noteState.versions.length < 2) return;

    noteState = this.syncActiveNoteVersion(canvas, path, nodeId) || noteState;
    const count = noteState.versions.length;
    noteState.active = (noteState.active + delta + count) % count;

    await this.persistState();
    await this.applyActiveNoteVersion(canvas, path, nodeId);
  }

  async switchNoteVersionToIndex(canvas, path, nodeId, index) {
    let noteState = this.getNoteVersionState(path, nodeId, false);
    if (!noteState || !noteState.versions.length) return;

    noteState = this.syncActiveNoteVersion(canvas, path, nodeId) || noteState;
    noteState.active = Math.max(0, Math.min(index, noteState.versions.length - 1));
    await this.persistState();
    await this.applyActiveNoteVersion(canvas, path, nodeId);
  }

  async deleteCurrentNoteVersion(canvas, path, nodeId) {
    let noteState = this.getNoteVersionState(path, nodeId, false);
    if (!noteState || noteState.versions.length <= 1) return;

    noteState = this.syncActiveNoteVersion(canvas, path, nodeId) || noteState;
    const removed = noteState.versions[noteState.active];

    noteState.versions.splice(noteState.active, 1);
    noteState.active = Math.min(noteState.active, noteState.versions.length - 1);

    // Removing a version never deletes the Markdown file from the Vault.
    // Version membership and file lifecycle are intentionally independent.
    await this.persistState();
    await this.applyActiveNoteVersion(canvas, path, nodeId);
  }

  openRenameNoteVersionModal(canvas, path, nodeId) {
    const noteState = this.getNoteVersionState(path, nodeId, false);
    if (!noteState) return;

    this.syncActiveNoteVersion(canvas, path, nodeId);

    const index = noteState.active;
    const version = noteState.versions[index];
    const plugin = this;

    class RenameNoteVersionModal extends Modal {
      onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("story-version-rename");

        contentEl.createEl("h2", { text: `Name Note Version ${index + 1}` });
        contentEl.createDiv({
          cls: "story-version-rename-help",
          text: "A short label only; it does not rename the underlying Markdown file."
        });

        const inputWrap = contentEl.createDiv({ cls: "story-version-rename-input" });
        const input = new TextComponent(inputWrap);
        input.setValue(version && version.label ? version.label : "");
        input.inputEl.placeholder = "Version label";
        input.inputEl.focus();
        input.inputEl.select();

        const actions = contentEl.createDiv({ cls: "story-version-rename-actions" });
        const cancel = actions.createEl("button", { text: "Cancel" });
        cancel.addEventListener("click", () => this.close());

        const save = actions.createEl("button", { text: "Save", cls: "mod-cta" });
        const commit = async () => {
          version.label = input.getValue().trim();
          await plugin.persistState();
          plugin.decorate(canvas, path);
          this.close();
        };
        save.addEventListener("click", () => void commit());
        input.inputEl.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            void commit();
          }
        });
      }

      onClose() {
        this.contentEl.empty();
      }
    }

    new RenameNoteVersionModal(this.app).open();
  }

  openNoteVersionOverview(canvas, path, nodeId) {
    const noteState = this.getNoteVersionState(path, nodeId, false);
    if (!noteState) {
      new Notice("This note card does not have version history yet.");
      return;
    }

    this.syncActiveNoteVersion(canvas, path, nodeId);
    void this.persistState();
    const plugin = this;

    class NoteVersionOverviewModal extends Modal {
      async onOpen() {
        this.modalEl.addClass("story-version-overview-modal");
        await this.render();
      }

      async render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("story-version-overview");

        const header = contentEl.createDiv({
          cls: "story-version-overview-header"
        });

        header.createEl("h2", { text: "Note versions" });

        header.createDiv({
          cls: "story-version-overview-count",
          text: `${noteState.versions.length} versions`
        });

        const list = contentEl.createDiv({
          cls: "story-version-overview-list"
        });

        for (let index = 0; index < noteState.versions.length; index++) {
          const version = noteState.versions[index];

          const row = list.createDiv({
            cls: "story-version-overview-item"
          });

          if (index === noteState.active) {
            row.addClass("is-active");
          }

          const meta = row.createDiv({
            cls: "story-version-overview-meta"
          });

          const titleWrap = meta.createDiv({
            cls: "story-version-overview-title-wrap"
          });

          titleWrap.createSpan({
            cls: "story-version-overview-number",
            text: plugin.versionDisplayName(version, index)
          });

          if (index === noteState.active) {
            titleWrap.createSpan({
              cls: "story-version-overview-active",
              text: "Current"
            });
          }

          plugin.addVersionReorderControls(
            meta,
            index,
            noteState.versions.length,
            async (delta) => {
              if (!plugin.moveVersionInState(noteState, index, delta)) return;
              await plugin.persistState();
              plugin.decorate(canvas, path);
              window.setTimeout(
                () => plugin.injectPopupToolbar(canvas, path),
                0
              );
              await this.render();
            }
          );

          const content = await plugin.readVaultText(version.file);

          row.createDiv({
            cls: "story-version-overview-preview",
            text: plugin.versionPreviewText(content)
          });

          row.createDiv({
            cls: "story-note-version-file",
            text: version.file
          });

          row.addEventListener("click", async () => {
            await plugin.switchNoteVersionToIndex(
              canvas,
              path,
              nodeId,
              index
            );
            this.close();
          });
        }
      }

      onClose() {
        this.modalEl.removeClass("story-version-overview-modal");
        this.contentEl.empty();
      }
    }

    new NoteVersionOverviewModal(this.app).open();
  }

  frameSnapshot(frame) {
    return {
      id: uid(),
      children: [...(frame.children || [])],
      direction: frame.direction || "vertical",
      gap: Number.isFinite(frame.gap) ? frame.gap : DEFAULT_GAP,
      padding: Number.isFinite(frame.padding) ? frame.padding : DEFAULT_PADDING,
      nestedSpacing: Number.isFinite(frame.nestedSpacing) ? frame.nestedSpacing : 16,
      nestedInset: Number.isFinite(frame.nestedInset) ? frame.nestedInset : 20,
      layoutPaused: !!frame.layoutPaused,
      crossAxisRatios: {},
      label: "",
      description: ""
    };
  }

  getFrameVersionState(path, groupId, create = false) {
    const state = this.canvasState(path, create);
    if (!state) return null;
    if (!state.frameVersions) state.frameVersions = {};

    let versionState = state.frameVersions[groupId];

    if (!versionState && create) {
      const frame = state.frames && state.frames[groupId];
      if (!frame) return null;

      versionState = {
        active: 0,
        versions: [this.frameSnapshot(frame)],
        visibleDetached: []
      };
      state.frameVersions[groupId] = versionState;
    }

    if (versionState) {
      if (!Array.isArray(versionState.visibleDetached)) versionState.visibleDetached = [];
      if (!Array.isArray(versionState.versions)) versionState.versions = [];

      for (const version of versionState.versions) {
        if (!Array.isArray(version.children)) version.children = [];
        if (!version.direction) version.direction = "vertical";
        if (!Number.isFinite(version.gap)) version.gap = this.defaultGap();
        if (!Number.isFinite(version.padding)) version.padding = this.defaultPadding();
        if (!Number.isFinite(version.nestedSpacing)) version.nestedSpacing = this.defaultNestedSpacing();
        if (!Number.isFinite(version.nestedInset)) version.nestedInset = this.defaultNestedInset();
        if (typeof version.layoutPaused !== "boolean") version.layoutPaused = false;
        if (!version.crossAxisRatios || typeof version.crossAxisRatios !== "object") {
          version.crossAxisRatios = {};
        }
        if (typeof version.label !== "string") version.label = "";
        if (typeof version.description !== "string") version.description = "";
      }
    }

    return versionState || null;
  }

  normalizeCrossAxisRatio(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;

    const clamped = Math.max(0, Math.min(1, numeric));

    if (Math.abs(clamped - 0) <= 0.08) return 0;
    if (Math.abs(clamped - 0.5) <= 0.08) return 0.5;
    if (Math.abs(clamped - 1) <= 0.08) return 1;

    return clamped;
  }

  inheritedCrossAxisRatio(
    canvas,
    path,
    frame,
    childId,
    insertIndex,
    ratioMap
  ) {
    const ratios = ratioMap || {};
    const children = [...(frame.children || [])];
    const newNode = this.liveNodeData(canvas, childId);
    const newIsNested = this.isManagedFrame(path, childId);

    const candidateIndexes = [];
    for (let distance = 1; distance <= children.length; distance += 1) {
      const left = insertIndex - distance;
      const right = insertIndex + distance;

      if (left >= 0) candidateIndexes.push(left);
      if (right < children.length) candidateIndexes.push(right);
    }

    for (const index of candidateIndexes) {
      const id = children[index];
      if (!id || id === childId) continue;

      const sibling = this.liveNodeData(canvas, id);
      if (!sibling) continue;

      const siblingIsNested = this.isManagedFrame(path, id);
      const sameKind =
        newIsNested === siblingIsNested &&
        (
          newIsNested ||
          !newNode ||
          sibling.type === newNode.type
        );

      if (
        sameKind &&
        Number.isFinite(Number(ratios[id]))
      ) {
        return this.normalizeCrossAxisRatio(ratios[id]);
      }
    }

    const ordinary = children
      .filter((id) => id !== childId)
      .filter((id) => !this.isManagedFrame(path, id))
      .map((id) => Number(ratios[id]))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    if (ordinary.length) {
      const mid = Math.floor(ordinary.length / 2);
      const median =
        ordinary.length % 2
          ? ordinary[mid]
          : (ordinary[mid - 1] + ordinary[mid]) / 2;

      return this.normalizeCrossAxisRatio(median);
    }

    for (const id of children) {
      if (id === childId) continue;
      if (Number.isFinite(Number(ratios[id]))) {
        return this.normalizeCrossAxisRatio(ratios[id]);
      }
    }

    return 0;
  }

  captureFrameCrossAxisRatios(canvas, path, frame) {
    const ratios = {};
    if (!canvas || !frame) return ratios;

    const group = this.liveNodeData(canvas, frame.groupId);
    if (!group) return ratios;

    const p = Number(frame.padding) || 0;
    const nestedInset = Number(frame.nestedInset) || 0;

    for (const childId of frame.children || []) {
      const child = this.liveNodeData(canvas, childId);
      if (!child) continue;

      const isNested = this.isManagedFrame(path, childId);

      if (frame.direction === "vertical") {
        const start =
          group.x + p + (isNested ? nestedInset : 0);
        const end =
          group.x + group.width - p - child.width;
        const range = end - start;

        ratios[childId] =
          this.normalizeCrossAxisRatio(
            range > 0.5
              ? (child.x - start) / range
              : 0
          );
      } else {
        const start =
          group.y + p + (isNested ? nestedInset : 0);
        const end =
          group.y + group.height - p - child.height;
        const range = end - start;

        ratios[childId] =
          this.normalizeCrossAxisRatio(
            range > 0.5
              ? (child.y - start) / range
              : 0
          );
      }
    }

    return ratios;
  }

  resetGeometryBaselineForPath(canvas, path) {
    for (const key of [...this.nodeGeometry.keys()]) {
      if (key.startsWith(`${path}::`)) {
        this.nodeGeometry.delete(key);
      }
    }

    for (const key of [...this.frameRelativeGeometry.keys()]) {
      if (key.startsWith(`${path}::`)) {
        this.frameRelativeGeometry.delete(key);
      }
    }

    this.refreshAllFrameRelativeGeometry(canvas, path);
  }

  syncActiveFrameVersion(path, groupId, canvas = null) {
    const state = this.canvasState(path, false);
    if (!state || !state.frames || !state.frames[groupId]) return null;

    const versionState = this.getFrameVersionState(path, groupId, false);
    if (!versionState || !versionState.versions.length) return versionState;

    versionState.active = Math.max(0, Math.min(versionState.active, versionState.versions.length - 1));
    const frame = state.frames[groupId];
    const version = versionState.versions[versionState.active];

    version.children = [...(frame.children || [])];
    version.direction = frame.direction || "vertical";
    version.gap = Number.isFinite(frame.gap) ? frame.gap : DEFAULT_GAP;
    version.padding = Number.isFinite(frame.padding) ? frame.padding : DEFAULT_PADDING;
    version.nestedSpacing = Number.isFinite(frame.nestedSpacing) ? frame.nestedSpacing : 16;
    version.nestedInset = Number.isFinite(frame.nestedInset) ? frame.nestedInset : 20;
    version.layoutPaused = !!frame.layoutPaused;

    if (canvas) {
      version.crossAxisRatios =
        this.captureFrameCrossAxisRatios(
          canvas,
          path,
          frame
        );
    }

    return versionState;
  }

  frameVersionUnionChildren(versionState) {
    const result = new Set();
    if (!versionState || !versionState.versions) return result;
    for (const version of versionState.versions) {
      for (const childId of version.children || []) result.add(childId);
    }
    return result;
  }

  nodeIsActiveFrameChild(path, nodeId) {
    const state = this.canvasState(path, false);
    if (!state || !state.frames) return false;
    for (const frame of Object.values(state.frames)) {
      if ((frame.children || []).includes(nodeId)) return true;
    }
    return false;
  }

  shouldHideForFrameVersions(path, nodeId) {
    const state = this.canvasState(path, false);
    if (!state || !state.frameVersions) return false;

    // Rule 1: any active managed Frame membership keeps the node visible.
    if (this.nodeIsActiveFrameChild(path, nodeId)) return false;

    let referencedByAnyVersion = false;
    let referencedByActiveVersion = false;
    let explicitlyDetachedVisible = false;

    for (const versionState of Object.values(state.frameVersions)) {
      if (
        !versionState ||
        !versionState.versions ||
        !versionState.versions.length
      ) {
        continue;
      }

      const union = this.frameVersionUnionChildren(versionState);
      if (!union.has(nodeId)) continue;

      referencedByAnyVersion = true;

      const activeIndex = Math.max(
        0,
        Math.min(
          versionState.active || 0,
          versionState.versions.length - 1
        )
      );

      const active = versionState.versions[activeIndex];

      if (
        active &&
        Array.isArray(active.children) &&
        active.children.includes(nodeId)
      ) {
        referencedByActiveVersion = true;
      }

      if (
        Array.isArray(versionState.visibleDetached) &&
        versionState.visibleDetached.includes(nodeId)
      ) {
        explicitlyDetachedVisible = true;
      }
    }

    // Rule 2: if any active Frame Version references it, it must be visible.
    if (referencedByActiveVersion) return false;

    // Rule 3: a user-dragged detached node remains visible even if inactive
    // versions still remember it.
    if (explicitlyDetachedVisible) return false;

    // Rule 4: hide only when the node belongs exclusively to inactive versions.
    return referencedByAnyVersion;
  }

  setFrameVersionHiddenRecursive(canvas, path, nodeId, hidden, visited = new Set()) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = canvas.nodes && canvas.nodes.get(nodeId);
    if (!node || !node.nodeEl) return;

    node.nodeEl.classList.toggle("story-frame-version-hidden", !!hidden);

    if (!this.isManagedFrame(path, nodeId)) return;
    const state = this.canvasState(path, false);
    const childFrame = state && state.frames && state.frames[nodeId];
    if (!childFrame) return;

    for (const childId of childFrame.children || []) {
      this.setFrameVersionHiddenRecursive(canvas, path, childId, hidden, visited);
    }
  }

  frameVersionVisibilitySummary(path, nodeId) {
    const state = this.canvasState(path, false);
    if (!state || !state.frameVersions) return [];

    const summary = [];

    for (const [groupId, versionState] of Object.entries(state.frameVersions)) {
      if (!versionState || !versionState.versions) continue;

      const activeIndex = Math.max(
        0,
        Math.min(
          versionState.active || 0,
          Math.max(0, versionState.versions.length - 1)
        )
      );

      const active = versionState.versions[activeIndex];
      const referenced = versionState.versions.some((version) =>
        (version.children || []).includes(nodeId)
      );

      if (!referenced) continue;

      summary.push({
        groupId,
        activeIndex,
        activeContains: !!(
          active &&
          (active.children || []).includes(nodeId)
        ),
        detachedVisible: !!(
          versionState.visibleDetached &&
          versionState.visibleDetached.includes(nodeId)
        )
      });
    }

    return summary;
  }

  collectFrameVersionHiddenSubtree(canvas, path, nodeId, hiddenSet, visited = new Set()) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    if (canvas.nodes && canvas.nodes.has(nodeId)) {
      hiddenSet.add(nodeId);
    }

    if (!this.isManagedFrame(path, nodeId)) return;

    const state = this.canvasState(path, false);
    const frame = state && state.frames && state.frames[nodeId];
    if (!frame) return;

    for (const childId of frame.children || []) {
      this.collectFrameVersionHiddenSubtree(
        canvas,
        path,
        childId,
        hiddenSet,
        visited
      );
    }
  }

  updateFrameVersionVisibility(canvas, path) {
    if (!canvas.nodes) return;

    const state = this.canvasState(path, false);
    if (!state || !state.frameVersions) {
      const previous = this.frameVersionHiddenNodes.get(path);
      if (previous) {
        for (const nodeId of previous) {
          const node = canvas.nodes.get(nodeId);
          if (node && node.nodeEl) {
            node.nodeEl.classList.remove("story-frame-version-hidden");
          }
        }
        this.frameVersionHiddenNodes.delete(path);
      }
      return;
    }

    // Build visibility indexes once.
    const activeMembership = new Set();
    for (const frame of Object.values(state.frames || {})) {
      for (const childId of frame.children || []) {
        activeMembership.add(childId);
      }
    }

    const referencedByAny = new Set();
    const referencedByActive = new Set();
    const detachedVisible = new Set();

    for (const versionState of Object.values(state.frameVersions || {})) {
      if (
        !versionState ||
        !Array.isArray(versionState.versions) ||
        !versionState.versions.length
      ) {
        continue;
      }

      for (const version of versionState.versions) {
        for (const childId of version.children || []) {
          referencedByAny.add(childId);
        }
      }

      const activeIndex = Math.max(
        0,
        Math.min(
          versionState.active || 0,
          versionState.versions.length - 1
        )
      );

      const activeVersion = versionState.versions[activeIndex];
      for (const childId of (activeVersion && activeVersion.children) || []) {
        referencedByActive.add(childId);
      }

      for (const childId of versionState.visibleDetached || []) {
        detachedVisible.add(childId);
      }
    }

    // Only nodes exclusively owned by inactive versions need hiding.
    const hiddenRoots = [];
    for (const nodeId of referencedByAny) {
      if (
        !activeMembership.has(nodeId) &&
        !referencedByActive.has(nodeId) &&
        !detachedVisible.has(nodeId)
      ) {
        hiddenRoots.push(nodeId);
      }
    }

    const nextHidden = new Set();
    for (const nodeId of hiddenRoots) {
      this.collectFrameVersionHiddenSubtree(
        canvas,
        path,
        nodeId,
        nextHidden
      );
    }

    const previousHidden =
      this.frameVersionHiddenNodes.get(path) ||
      new Set();

    // Unhide only nodes whose state changed.
    for (const nodeId of previousHidden) {
      if (nextHidden.has(nodeId)) continue;
      const node = canvas.nodes.get(nodeId);
      if (node && node.nodeEl) {
        node.nodeEl.classList.remove("story-frame-version-hidden");
      }
    }

    // Hide only newly hidden nodes.
    for (const nodeId of nextHidden) {
      if (previousHidden.has(nodeId)) continue;
      const node = canvas.nodes.get(nodeId);
      if (node && node.nodeEl) {
        node.nodeEl.classList.add("story-frame-version-hidden");
      }
    }

    this.frameVersionHiddenNodes.set(path, nextHidden);
  }

  applyActiveFrameVersion(canvas, path, groupId) {
    const state = this.canvasState(path, false);
    if (!state || !state.frames || !state.frames[groupId]) {
      return false;
    }

    const versionState =
      this.getFrameVersionState(path, groupId, false);

    if (!versionState || !versionState.versions.length) {
      return false;
    }

    versionState.active = Math.max(
      0,
      Math.min(
        versionState.active,
        versionState.versions.length - 1
      )
    );

    const frame = state.frames[groupId];
    const version =
      versionState.versions[versionState.active];

    // Branch replacement is one geometry transaction. Ignore watcher polling
    // until Obsidian has settled the setData/setNode geometry mutations.
    this.geometryIgnoreUntil.set(
      path,
      Date.now() + 420
    );

    frame.children = [...(version.children || [])];
    frame.direction = version.direction || "vertical";
    frame.gap = Number.isFinite(version.gap)
      ? version.gap
      : this.defaultGap();
    frame.padding = Number.isFinite(version.padding)
      ? version.padding
      : this.defaultPadding();
    frame.nestedSpacing =
      Number.isFinite(version.nestedSpacing)
        ? version.nestedSpacing
        : this.defaultNestedSpacing();
    frame.nestedInset =
      Number.isFinite(version.nestedInset)
        ? version.nestedInset
        : this.defaultNestedInset();
    frame.layoutPaused = !!version.layoutPaused;

    versionState.visibleDetached = [];

    // Incoming branch must be visible before layout geometry is read.
    this.updateFrameVersionVisibility(canvas, path);
    this.updateFrameLabelFromActiveVersion(
      canvas,
      path,
      groupId
    );

    const reflowed = this.reflowFrame(
      canvas,
      path,
      frame,
      false,
      true,
      true,
      version.crossAxisRatios || {}
    );

    if (!reflowed) {
      this.queuePrepareAllCanvases();
      return false;
    }

    this.reflowParentChain(canvas, path, groupId);
    this.updateFrameVersionVisibility(canvas, path);

    // Throw away every old watcher baseline from the previous branch.
    this.resetGeometryBaselineForPath(canvas, path);

    // Persist the final placement as this branch's own alignment snapshot.
    version.crossAxisRatios =
      this.captureFrameCrossAxisRatios(
        canvas,
        path,
        frame
      );

    this.flushManagedFrameIdentity(
      canvas,
      path,
      frame
    );

    canvas.requestSave(false);
    void this.persistState();

    this.decorate(canvas, path);

    window.setTimeout(
      () => this.injectPopupToolbar(canvas, path),
      0
    );

    return true;
  }

  freshCanvasId(usedIds) {
    let id = uid();
    while (usedIds.has(id)) {
      id = uid();
    }
    usedIds.add(id);
    return id;
  }

  cloneVersionStateIds(versionState) {
    const next = clone(versionState);

    if (Array.isArray(next.versions)) {
      for (const version of next.versions) {
        version.id = uid();
      }
    }

    return next;
  }

  waitForCanvasNodes(canvas, nodeIds, timeoutMs = 1800) {
    const ids = [...new Set(nodeIds || [])];
    if (!ids.length) return Promise.resolve(true);

    return new Promise((resolve) => {
      const started = Date.now();

      const check = () => {
        const ready =
          !!canvas.nodes &&
          ids.every((id) => canvas.nodes.has(id));

        if (ready) {
          resolve(true);
          return;
        }

        if (Date.now() - started >= timeoutMs) {
          resolve(false);
          return;
        }

        window.setTimeout(check, 30);
      };

      check();
    });
  }

  async cloneFrameBranchNodes(canvas, path, rootChildIds) {
    const state = this.canvasState(path, false);
    if (!state || typeof canvas.getData !== "function") {
      return null;
    }

    let canvasData = null;
    try {
      canvasData = clone(canvas.getData());
    } catch (_) {
      return null;
    }

    if (!canvasData || !Array.isArray(canvasData.nodes)) {
      return null;
    }

    if (!Array.isArray(canvasData.edges)) {
      canvasData.edges = [];
    }

    const sourceNodes = [...canvasData.nodes];
    const sourceEdges = [...canvasData.edges];

    const nodeById = new Map(
      sourceNodes
        .filter((node) => node && node.id)
        .map((node) => [node.id, node])
    );

    const usedIds = new Set(
      [
        ...sourceNodes.map((node) => node.id),
        ...sourceEdges.map((edge) => edge.id)
      ].filter(Boolean)
    );

    const idMap = new Map();
    const clonedNodes = [];
    const clonedFrames = {};
    const clonedFrameVersions = {};
    const clonedCardVersions = {};
    const clonedNoteVersions = {};

    const ensureClone = (oldId) => {
      if (idMap.has(oldId)) {
        return idMap.get(oldId);
      }

      const source = nodeById.get(oldId);
      if (!source) return null;

      const newId = this.freshCanvasId(usedIds);
      idMap.set(oldId, newId);

      const nodeCopy = clone(source);
      nodeCopy.id = newId;
      clonedNodes.push(nodeCopy);

      if (state.cardVersions && state.cardVersions[oldId]) {
        clonedCardVersions[newId] =
          this.cloneVersionStateIds(
            state.cardVersions[oldId]
          );
      }

      if (state.noteVersions && state.noteVersions[oldId]) {
        clonedNoteVersions[newId] =
          this.cloneVersionStateIds(
            state.noteVersions[oldId]
          );
      }

      const managedFrame =
        state.frames && state.frames[oldId];

      if (managedFrame) {
        const referencedChildren = new Set(
          managedFrame.children || []
        );

        const oldFrameVersions =
          state.frameVersions &&
          state.frameVersions[oldId];

        if (oldFrameVersions) {
          for (const version of oldFrameVersions.versions || []) {
            for (const childId of version.children || []) {
              referencedChildren.add(childId);
            }
          }

          for (const childId of oldFrameVersions.visibleDetached || []) {
            referencedChildren.add(childId);
          }
        }

        for (const childId of referencedChildren) {
          ensureClone(childId);
        }

        const frameCopy = clone(managedFrame);
        frameCopy.groupId = newId;
        frameCopy.children = (managedFrame.children || [])
          .map((childId) => idMap.get(childId))
          .filter(Boolean);

        const fixedSizes = {};
        for (const [childId, size] of Object.entries(
          managedFrame.fixedSizes || {}
        )) {
          const mapped = idMap.get(childId);
          if (mapped) fixedSizes[mapped] = clone(size);
        }
        frameCopy.fixedSizes = fixedSizes;

        clonedFrames[newId] = frameCopy;

        if (oldFrameVersions) {
          const fvCopy =
            this.cloneVersionStateIds(oldFrameVersions);

          for (const version of fvCopy.versions || []) {
            version.children = (version.children || [])
              .map((childId) => idMap.get(childId))
              .filter(Boolean);
          }

          fvCopy.visibleDetached =
            (fvCopy.visibleDetached || [])
              .map((childId) => idMap.get(childId))
              .filter(Boolean);

          clonedFrameVersions[newId] = fvCopy;
        }
      }

      return newId;
    };

    const clonedRootIds = (rootChildIds || [])
      .map((id) => ensureClone(id))
      .filter(Boolean);

    const clonedEdges = [];
    for (const edge of sourceEdges) {
      if (
        !edge ||
        !idMap.has(edge.fromNode) ||
        !idMap.has(edge.toNode)
      ) {
        continue;
      }

      const edgeCopy = clone(edge);
      edgeCopy.id = this.freshCanvasId(usedIds);
      edgeCopy.fromNode = idMap.get(edge.fromNode);
      edgeCopy.toNode = idMap.get(edge.toNode);
      clonedEdges.push(edgeCopy);
    }

    canvasData.nodes.push(...clonedNodes);
    canvasData.edges.push(...clonedEdges);

    // Persist cloned plugin metadata as a separate subtree.
    Object.assign(state.frames, clonedFrames);
    Object.assign(state.frameVersions, clonedFrameVersions);
    Object.assign(state.cardVersions, clonedCardVersions);
    Object.assign(state.noteVersions, clonedNoteVersions);

    canvas.setData(canvasData);
    canvas.requestSave(false);
    await this.persistState();

    const ready = await this.waitForCanvasNodes(
      canvas,
      clonedNodes.map((node) => node.id)
    );

    return {
      clonedRootIds,
      clonedNodeIds: clonedNodes.map((node) => node.id),
      ready,
      idMap
    };
  }

  async duplicateFrameVersion(canvas, path, groupId) {
    let versionState =
      this.getFrameVersionState(path, groupId, true);

    if (!versionState) return;

    versionState =
      this.syncActiveFrameVersion(path, groupId, canvas) ||
      versionState;

    const current =
      versionState.versions[versionState.active];

    // Old releases duplicated only the array of child IDs, so two branches
    // edited the exact same Canvas nodes. Clone the branch subtree instead.
    const cloneResult = await this.cloneFrameBranchNodes(
      canvas,
      path,
      current.children || []
    );

    if (!cloneResult) {
      new Notice("Could not duplicate this Frame branch.");
      return;
    }

    versionState.versions.splice(
      versionState.active + 1,
      0,
      {
        id: uid(),
        children: [...cloneResult.clonedRootIds],
        direction: current.direction,
        gap: current.gap,
        padding: current.padding,
        nestedSpacing: current.nestedSpacing,
        nestedInset: current.nestedInset,
        layoutPaused: current.layoutPaused,
        crossAxisRatios: {},
        label: "",
        description: ""
      }
    );

    versionState.active += 1;
    versionState.visibleDetached = [];

    await this.persistState();

    if (!cloneResult.ready) {
      this.queuePrepareAllCanvases();
      new Notice(
        `Duplicated independent Frame branch ${versionState.active + 1}/${versionState.versions.length}. Waiting for Canvas node hydration.`
      );
      return;
    }

    this.applyActiveFrameVersion(
      canvas,
      path,
      groupId
    );

    new Notice(
      `Duplicated independent Frame branch ${versionState.active + 1}/${versionState.versions.length}`
    );
  }

  async newBlankFrameVersion(canvas, path, groupId) {
    let versionState = this.getFrameVersionState(path, groupId, true);
    if (!versionState) return;

    versionState = this.syncActiveFrameVersion(path, groupId, canvas) || versionState;
    const current = versionState.versions[versionState.active];

    versionState.versions.splice(versionState.active + 1, 0, {
      id: uid(),
      children: [],
      direction: current.direction,
      gap: current.gap,
      padding: current.padding,
      nestedSpacing: current.nestedSpacing,
      nestedInset: current.nestedInset,
      layoutPaused: false,
      crossAxisRatios: {},
      label: "",
      description: ""
    });

    versionState.active += 1;
    versionState.visibleDetached = [];
    await this.persistState();
    this.applyActiveFrameVersion(canvas, path, groupId);
    new Notice(`Blank frame version ${versionState.active + 1}/${versionState.versions.length}`);
  }

  async switchFrameVersion(canvas, path, groupId, delta) {
    let versionState = this.getFrameVersionState(path, groupId, false);
    if (!versionState || versionState.versions.length < 2) return;

    versionState = this.syncActiveFrameVersion(path, groupId, canvas) || versionState;
    const count = versionState.versions.length;
    versionState.active = (versionState.active + delta + count) % count;
    const knownRefs = this.frameVersionUnionChildren(versionState);
    versionState.visibleDetached = (versionState.visibleDetached || [])
      .filter((id) => knownRefs.has(id));

    await this.persistState();
    this.applyActiveFrameVersion(canvas, path, groupId);
  }

  async switchFrameVersionToIndex(canvas, path, groupId, index) {
    let versionState = this.getFrameVersionState(path, groupId, false);
    if (!versionState || !versionState.versions.length) return;

    versionState = this.syncActiveFrameVersion(path, groupId, canvas) || versionState;
    versionState.active = Math.max(0, Math.min(index, versionState.versions.length - 1));
    const knownRefs = this.frameVersionUnionChildren(versionState);
    versionState.visibleDetached = (versionState.visibleDetached || [])
      .filter((id) => knownRefs.has(id));

    await this.persistState();
    this.applyActiveFrameVersion(canvas, path, groupId);
  }

  collectFrameBranchSubtreeIds(path, rootIds) {
    const state = this.canvasState(path, false);
    const result = new Set();
    const visited = new Set();

    if (!state) return result;

    const visit = (nodeId) => {
      if (!nodeId || visited.has(nodeId)) return;
      visited.add(nodeId);
      result.add(nodeId);

      const frame = state.frames && state.frames[nodeId];
      if (!frame) return;

      const children = new Set(frame.children || []);
      const versionState =
        state.frameVersions &&
        state.frameVersions[nodeId];

      if (versionState) {
        for (const version of versionState.versions || []) {
          for (const childId of version.children || []) {
            children.add(childId);
          }
        }

        for (const childId of versionState.visibleDetached || []) {
          children.add(childId);
        }
      }

      for (const childId of children) {
        visit(childId);
      }
    };

    for (const rootId of rootIds || []) {
      visit(rootId);
    }

    return result;
  }

  protectedDeletedBranchNodes(path, candidateIds) {
    const state = this.canvasState(path, false);
    const protectedIds = new Set();

    if (!state || !candidateIds || !candidateIds.size) {
      return protectedIds;
    }

    // References coming from NON-candidate managed Frames are external owners.
    // Candidate nested Frames do not protect their own descendants unless the
    // nested Frame itself is first proven to survive elsewhere.
    for (const [frameId, frame] of Object.entries(state.frames || {})) {
      if (candidateIds.has(frameId)) continue;

      for (const childId of frame.children || []) {
        if (candidateIds.has(childId)) {
          protectedIds.add(childId);
        }
      }

      const versionState =
        state.frameVersions &&
        state.frameVersions[frameId];

      if (versionState) {
        for (const version of versionState.versions || []) {
          for (const childId of version.children || []) {
            if (candidateIds.has(childId)) {
              protectedIds.add(childId);
            }
          }
        }

        for (const childId of versionState.visibleDetached || []) {
          if (candidateIds.has(childId)) {
            protectedIds.add(childId);
          }
        }
      }
    }

    // A node explicitly dragged out to free Canvas must survive branch deletion.
    for (const versionState of Object.values(state.frameVersions || {})) {
      for (const childId of versionState.visibleDetached || []) {
        if (candidateIds.has(childId)) {
          protectedIds.add(childId);
        }
      }
    }

    // If a candidate managed Frame survives because another branch references
    // it, its entire internally-owned subtree must survive with it.
    const expandProtectedFrame = (frameId) => {
      const frame = state.frames && state.frames[frameId];
      if (!frame) return;

      const refs = new Set(frame.children || []);
      const versionState =
        state.frameVersions &&
        state.frameVersions[frameId];

      if (versionState) {
        for (const version of versionState.versions || []) {
          for (const childId of version.children || []) {
            refs.add(childId);
          }
        }

        for (const childId of versionState.visibleDetached || []) {
          refs.add(childId);
        }
      }

      for (const childId of refs) {
        if (!candidateIds.has(childId)) continue;
        if (protectedIds.has(childId)) continue;

        protectedIds.add(childId);

        if (state.frames && state.frames[childId]) {
          expandProtectedFrame(childId);
        }
      }
    };

    for (const nodeId of [...protectedIds]) {
      if (state.frames && state.frames[nodeId]) {
        expandProtectedFrame(nodeId);
      }
    }

    return protectedIds;
  }

  cleanupRemovedBranchState(path, removedIds) {
    const state = this.canvasState(path, false);
    if (!state || !removedIds || !removedIds.size) return;

    for (const nodeId of removedIds) {
      if (state.frames) delete state.frames[nodeId];
      if (state.frameVersions) delete state.frameVersions[nodeId];
      if (state.cardVersions) delete state.cardVersions[nodeId];
      if (state.noteVersions) delete state.noteVersions[nodeId];
    }

    for (const frame of Object.values(state.frames || {})) {
      frame.children = (frame.children || [])
        .filter((id) => !removedIds.has(id));

      if (frame.fixedSizes) {
        for (const nodeId of removedIds) {
          delete frame.fixedSizes[nodeId];
        }
      }
    }

    for (const versionState of Object.values(state.frameVersions || {})) {
      for (const version of versionState.versions || []) {
        version.children = (version.children || [])
          .filter((id) => !removedIds.has(id));
      }

      versionState.visibleDetached =
        (versionState.visibleDetached || [])
          .filter((id) => !removedIds.has(id));
    }
  }

  async removeCanvasNodesById(canvas, nodeIds) {
    const ids = new Set(nodeIds || []);
    if (!ids.size) return true;

    if (typeof canvas.getData !== "function") return false;

    let data = null;
    try {
      data = clone(canvas.getData());
    } catch (_) {
      return false;
    }

    if (!data || !Array.isArray(data.nodes)) return false;
    if (!Array.isArray(data.edges)) data.edges = [];

    data.nodes = data.nodes.filter(
      (node) => !node || !ids.has(node.id)
    );

    data.edges = data.edges.filter(
      (edge) =>
        edge &&
        !ids.has(edge.fromNode) &&
        !ids.has(edge.toNode)
    );

    canvas.setData(data);
    canvas.requestSave(false);
    return true;
  }

  async garbageCollectDeletedFrameBranch(
    canvas,
    path,
    deletedRootIds
  ) {
    const candidates =
      this.collectFrameBranchSubtreeIds(
        path,
        deletedRootIds
      );

    if (!candidates.size) {
      return { removed: 0, kept: 0 };
    }

    const protectedIds =
      this.protectedDeletedBranchNodes(
        path,
        candidates
      );

    const removedIds = new Set(
      [...candidates].filter(
        (id) => !protectedIds.has(id)
      )
    );

    if (!removedIds.size) {
      return {
        removed: 0,
        kept: protectedIds.size
      };
    }

    // Clean plugin metadata first, then remove physical Canvas nodes in one
    // atomic setData pass. This prevents deleted branch nodes from becoming
    // ordinary visible "blank cards".
    this.cleanupRemovedBranchState(
      path,
      removedIds
    );

    const removed =
      await this.removeCanvasNodesById(
        canvas,
        removedIds
      );

    if (!removed) {
      return {
        removed: 0,
        kept: candidates.size
      };
    }

    return {
      removed: removedIds.size,
      kept: protectedIds.size
    };
  }

  async deleteCurrentFrameVersion(canvas, path, groupId) {
    let versionState =
      this.getFrameVersionState(
        path,
        groupId,
        false
      );

    if (
      !versionState ||
      versionState.versions.length <= 1
    ) {
      return;
    }

    versionState =
      this.syncActiveFrameVersion(
        path,
        groupId
      ) || versionState;

    const deletedIndex = versionState.active;
    const deletedVersion =
      versionState.versions[deletedIndex];

    const deletedRootIds = [
      ...((deletedVersion && deletedVersion.children) || [])
    ];

    versionState.versions.splice(
      deletedIndex,
      1
    );

    versionState.active = Math.min(
      deletedIndex,
      versionState.versions.length - 1
    );

    // IMPORTANT:
    // Switch the owner Frame state to the surviving branch BEFORE calculating
    // orphan ownership. Otherwise frame.children still points at the deleted
    // branch and falsely protects every deleted node from garbage collection.
    const state = this.canvasState(path, false);
    const frame =
      state &&
      state.frames &&
      state.frames[groupId];

    const activeVersion =
      versionState.versions[
        versionState.active
      ];

    if (frame && activeVersion) {
      frame.children = [
        ...(activeVersion.children || [])
      ];
      frame.direction =
        activeVersion.direction || "vertical";
      frame.gap = Number.isFinite(activeVersion.gap)
        ? activeVersion.gap
        : this.defaultGap();
      frame.padding =
        Number.isFinite(activeVersion.padding)
          ? activeVersion.padding
          : this.defaultPadding();
      frame.nestedSpacing =
        Number.isFinite(activeVersion.nestedSpacing)
          ? activeVersion.nestedSpacing
          : this.defaultNestedSpacing();
      frame.nestedInset =
        Number.isFinite(activeVersion.nestedInset)
          ? activeVersion.nestedInset
          : this.defaultNestedInset();
      frame.layoutPaused =
        !!activeVersion.layoutPaused;
    }

    const remainingRefs =
      this.frameVersionUnionChildren(
        versionState
      );

    versionState.visibleDetached =
      (versionState.visibleDetached || [])
        .filter((id) => remainingRefs.has(id));

    const gcResult =
      await this.garbageCollectDeletedFrameBranch(
        canvas,
        path,
        deletedRootIds
      );

    await this.persistState();

    // setData used by GC can rebuild live node instances. Let Canvas hydrate
    // before re-applying/reflowing the surviving branch.
    if (gcResult.removed > 0) {
      const survivingIds =
        (activeVersion && activeVersion.children) || [];

      await this.waitForCanvasNodes(
        canvas,
        survivingIds,
        1800
      );
    }

    this.applyActiveFrameVersion(
      canvas,
      path,
      groupId
    );

    this.queuePrepareAllCanvases();

    new Notice(
      gcResult.removed > 0
        ? `Deleted Frame branch and removed ${gcResult.removed} branch-only Canvas node${gcResult.removed === 1 ? "" : "s"}.`
        : "Deleted Frame branch."
    );
  }

  frameChildDisplayName(canvas, path, nodeId) {
    const data = this.liveNodeData(canvas, nodeId);
    if (!data) return "(missing)";
    if (data.type === "text") {
      const text = String(data.text || "").replace(/\s+/g, " ").trim();
      return text ? (text.length > 32 ? `${text.slice(0, 32)}…` : text) : "(blank card)";
    }
    if (data.type === "file") return String(data.file || "note").split("/").pop() || "note";
    if (data.type === "group" && this.isManagedFrame(path, nodeId)) {
      return data.label ? `[Frame] ${data.label}` : "[Nested Frame]";
    }
    return data.type || "item";
  }

  frameVersionDisplayName(version, index) {
    const label =
      version && typeof version.label === "string"
        ? version.label.trim()
        : "";

    return label
      ? `Frame Version ${index + 1} — ${label}`
      : `Frame Version ${index + 1}`;
  }

  openRenameFrameVersionModal(canvas, path, groupId) {
    const versionState = this.getFrameVersionState(path, groupId, false);
    if (!versionState || !versionState.versions.length) return;

    this.syncActiveFrameVersion(path, groupId, canvas);

    const index = versionState.active;
    const version = versionState.versions[index];
    const plugin = this;

    class RenameFrameVersionModal extends Modal {
      onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("story-version-rename");

        contentEl.createEl("h2", {
          text: `Frame Version ${index + 1}`
        });

        contentEl.createDiv({
          cls: "story-version-rename-help",
          text: "Name this branch and write a short description of what changes in this version."
        });

        const nameLabel = contentEl.createEl("label", {
          cls: "story-version-field-label",
          text: "Branch name"
        });

        const inputWrap = contentEl.createDiv({
          cls: "story-version-rename-input"
        });

        const input = new TextComponent(inputWrap);
        input.setValue(version && version.label ? version.label : "");
        input.inputEl.placeholder = "例如：原案、戰鬥線、結局 B";

        contentEl.createEl("label", {
          cls: "story-version-field-label",
          text: "Description"
        });

        const description = contentEl.createEl("textarea", {
          cls: "story-frame-version-description-input"
        });
        description.rows = 5;
        description.placeholder = "簡單記錄這個分支改了什麼、適合什麼走向……";
        description.value =
          version && typeof version.description === "string"
            ? version.description
            : "";

        input.inputEl.focus();
        input.inputEl.select();

        const actions = contentEl.createDiv({
          cls: "story-version-rename-actions"
        });

        const cancel = actions.createEl("button", { text: "Cancel" });
        cancel.addEventListener("click", () => this.close());

        const save = actions.createEl("button", {
          text: "Save",
          cls: "mod-cta"
        });

        const commit = async () => {
          version.label = input.getValue().trim();
          version.description = description.value.trim();

          if (plugin.settings.followFrameVersionName) {
            plugin.updateFrameLabelFromActiveVersion(
              canvas,
              path,
              groupId
            );
            canvas.requestSave(false);
          }

          await plugin.persistState();
          plugin.decorate(canvas, path);

          window.setTimeout(
            () => plugin.injectPopupToolbar(canvas, path),
            0
          );

          this.close();
        };

        save.addEventListener("click", () => void commit());

        input.inputEl.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            description.focus();
          }
        });

        description.addEventListener("keydown", (ev) => {
          if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
            ev.preventDefault();
            void commit();
          }
        });
      }

      onClose() {
        this.contentEl.empty();
      }
    }

    new RenameFrameVersionModal(this.app).open();
  }

  frameVersionPreview(canvas, path, version) {
    const items = (version.children || []).map((id) => this.frameChildDisplayName(canvas, path, id));
    const head = `${version.direction === "horizontal" ? "Horizontal" : "Vertical"} · ${items.length} items`;
    if (!items.length) return `${head}\n(blank frame)`;
    const preview = items.slice(0, 6).join(" → ");
    return items.length > 6 ? `${head}\n${preview} → …` : `${head}\n${preview}`;
  }

  openFrameVersionOverview(canvas, path, groupId) {
    const versionState = this.getFrameVersionState(path, groupId, false);
    if (!versionState) return;

    this.syncActiveFrameVersion(path, groupId, canvas);
    void this.persistState();
    const plugin = this;

    class FrameVersionOverviewModal extends Modal {
      onOpen() {
        this.modalEl.addClass("story-version-overview-modal");
        this.render();
      }

      render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("story-version-overview");

        const header = contentEl.createDiv({
          cls: "story-version-overview-header"
        });

        header.createEl("h2", { text: "Frame versions" });

        header.createDiv({
          cls: "story-version-overview-count",
          text: `${versionState.versions.length} versions`
        });

        const list = contentEl.createDiv({
          cls: "story-version-overview-list"
        });

        versionState.versions.forEach((version, index) => {
          const row = list.createDiv({
            cls: "story-version-overview-item"
          });

          if (index === versionState.active) {
            row.addClass("is-active");
          }

          const meta = row.createDiv({
            cls: "story-version-overview-meta"
          });

          const titleWrap = meta.createDiv({
            cls: "story-version-overview-title-wrap"
          });

          titleWrap.createSpan({
            cls: "story-version-overview-number",
            text: plugin.frameVersionDisplayName(version, index)
          });

          if (index === versionState.active) {
            titleWrap.createSpan({
              cls: "story-version-overview-active",
              text: "Current"
            });
          }

          plugin.addVersionReorderControls(
            meta,
            index,
            versionState.versions.length,
            async (delta) => {
              if (!plugin.moveVersionInState(versionState, index, delta)) return;
              await plugin.persistState();
              plugin.decorate(canvas, path);
              window.setTimeout(
                () => plugin.injectPopupToolbar(canvas, path),
                0
              );
              this.render();
            }
          );

          row.createDiv({
            cls: "story-frame-version-description",
            text:
              version && version.description
                ? version.description
                : "No description yet."
          });

          row.createEl("pre", {
            cls: "story-frame-version-preview",
            text: plugin.frameVersionPreview(canvas, path, version)
          });

          row.addEventListener("click", async () => {
            await plugin.switchFrameVersionToIndex(
              canvas,
              path,
              groupId,
              index
            );
            this.close();
          });
        });
      }

      onClose() {
        this.modalEl.removeClass("story-version-overview-modal");
        this.contentEl.empty();
      }
    }

    new FrameVersionOverviewModal(this.app).open();
  }

  selectedSingleNode(canvas) {
    if (!canvas.selection || canvas.selection.size !== 1) return null;
    return [...canvas.selection][0] || null;
  }

  getCardVersionState(path, nodeId, create = false, canvas = null) {
    const state = this.canvasState(path, create);
    if (!state) return null;
    if (!state.cardVersions) state.cardVersions = {};

    let versionState = state.cardVersions[nodeId];

    if (!versionState && create) {
      const nodeData = canvas ? this.liveNodeData(canvas, nodeId) : null;
      if (!nodeData || nodeData.type !== "text") return null;

      versionState = {
        active: 0,
        versions: [{
          id: uid(),
          text: typeof nodeData.text === "string" ? nodeData.text : "",
          width: Number(nodeData.width) || null,
          height: Number(nodeData.height) || null,
          label: ""
        }]
      };
      state.cardVersions[nodeId] = versionState;
    }

    return versionState || null;
  }

  syncActiveCardVersion(canvas, path, nodeId) {
    const versionState = this.getCardVersionState(path, nodeId, false);
    if (!versionState) return null;

    const nodeData = this.liveNodeData(canvas, nodeId);
    if (!nodeData || nodeData.type !== "text") return null;

    const active = Math.max(0, Math.min(versionState.active, versionState.versions.length - 1));
    versionState.active = active;

    if (versionState.versions[active]) {
      versionState.versions[active].text =
        typeof nodeData.text === "string" ? nodeData.text : "";
      versionState.versions[active].width = Number(nodeData.width) || versionState.versions[active].width || null;
      versionState.versions[active].height = Number(nodeData.height) || versionState.versions[active].height || null;
    }

    // Migrate older 0.4.0/0.4.1 version entries that only stored text.
    for (const version of versionState.versions) {
      if (!Number.isFinite(version.width)) {
        version.width = Number(nodeData.width) || null;
      }
      if (!Number.isFinite(version.height)) {
        version.height = Number(nodeData.height) || null;
      }
      if (typeof version.label !== "string") {
        version.label = "";
      }
    }

    return versionState;
  }

  applyActiveCardVersion(canvas, path, nodeId) {
    const versionState = this.getCardVersionState(path, nodeId, false);
    if (!versionState || !versionState.versions.length) return false;

    versionState.active = Math.max(
      0,
      Math.min(versionState.active, versionState.versions.length - 1)
    );

    const nodeData = this.liveNodeData(canvas, nodeId);
    if (!nodeData || nodeData.type !== "text") return false;

    const version = versionState.versions[versionState.active];
    const patch = {
      text: typeof version.text === "string" ? version.text : ""
    };

    if (Number.isFinite(version.width)) patch.width = version.width;
    if (Number.isFinite(version.height)) patch.height = version.height;

    this.patchLiveNode(canvas, nodeId, patch);

    // A version may have a very different card size. Keep x/y shared, but let
    // managed parent Frames react to the version-specific width/height.
    this.reflowParentChain(canvas, path, nodeId);

    canvas.requestSave(false);
    this.decorate(canvas, path);
    window.setTimeout(() => this.injectPopupToolbar(canvas, path), 0);
    return true;
  }

  async duplicateCardVersion(canvas, path, nodeId) {
    let versionState = this.getCardVersionState(path, nodeId, true, canvas);
    if (!versionState) {
      new Notice("Card versions currently support Canvas text cards.");
      return;
    }

    versionState = this.syncActiveCardVersion(canvas, path, nodeId) || versionState;
    const current = versionState.versions[versionState.active];

    versionState.versions.splice(versionState.active + 1, 0, {
      id: uid(),
      text: current && typeof current.text === "string" ? current.text : "",
      width: current && Number.isFinite(current.width) ? current.width : null,
      height: current && Number.isFinite(current.height) ? current.height : null,
      label: ""
    });
    versionState.active += 1;

    await this.persistState();
    this.applyActiveCardVersion(canvas, path, nodeId);
    new Notice(`Version ${versionState.active + 1}/${versionState.versions.length}`);
  }

  async newBlankCardVersion(canvas, path, nodeId) {
    let versionState = this.getCardVersionState(path, nodeId, true, canvas);
    if (!versionState) {
      new Notice("Card versions currently support Canvas text cards.");
      return;
    }

    versionState = this.syncActiveCardVersion(canvas, path, nodeId) || versionState;
    const currentNode = this.liveNodeData(canvas, nodeId);
    versionState.versions.splice(versionState.active + 1, 0, {
      id: uid(),
      text: "",
      width: currentNode ? Number(currentNode.width) || null : null,
      height: currentNode ? Number(currentNode.height) || null : null,
      label: ""
    });
    versionState.active += 1;

    await this.persistState();
    this.applyActiveCardVersion(canvas, path, nodeId);
    new Notice(`Blank version ${versionState.active + 1}/${versionState.versions.length}`);
  }

  async switchCardVersion(canvas, path, nodeId, delta) {
    let versionState = this.getCardVersionState(path, nodeId, false);
    if (!versionState || versionState.versions.length < 2) return;

    versionState = this.syncActiveCardVersion(canvas, path, nodeId) || versionState;

    const count = versionState.versions.length;
    versionState.active = (versionState.active + delta + count) % count;

    await this.persistState();
    this.applyActiveCardVersion(canvas, path, nodeId);
  }

  async deleteCurrentCardVersion(canvas, path, nodeId) {
    let versionState = this.getCardVersionState(path, nodeId, false);
    if (!versionState) return;

    versionState = this.syncActiveCardVersion(canvas, path, nodeId) || versionState;

    if (versionState.versions.length <= 1) {
      await this.removeCardVersionHistory(canvas, path, nodeId);
      return;
    }

    versionState.versions.splice(versionState.active, 1);
    versionState.active = Math.min(versionState.active, versionState.versions.length - 1);

    await this.persistState();
    this.applyActiveCardVersion(canvas, path, nodeId);
    new Notice(`Version ${versionState.active + 1}/${versionState.versions.length}`);
  }

  async removeCardVersionHistory(canvas, path, nodeId) {
    const state = this.canvasState(path, false);
    if (!state || !state.cardVersions || !state.cardVersions[nodeId]) return;

    this.syncActiveCardVersion(canvas, path, nodeId);
    delete state.cardVersions[nodeId];

    await this.persistState();
    this.decorate(canvas, path);
    window.setTimeout(() => this.injectPopupToolbar(canvas, path), 0);
    new Notice("Version history removed. Current card content was kept.");
  }

  versionDisplayName(version, index) {
    const label = version && typeof version.label === "string"
      ? version.label.trim()
      : "";

    return label ? `Version ${index + 1} — ${label}` : `Version ${index + 1}`;
  }

  openRenameVersionModal(canvas, path, nodeId) {
    const versionState = this.getCardVersionState(path, nodeId, false);
    if (!versionState) return;

    this.syncActiveCardVersion(canvas, path, nodeId);

    const activeIndex = versionState.active;
    const activeVersion = versionState.versions[activeIndex];
    const plugin = this;

    class RenameVersionModal extends Modal {
      onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("story-version-rename");

        contentEl.createEl("h2", {
          text: `Name Version ${activeIndex + 1}`
        });

        contentEl.createDiv({
          cls: "story-version-rename-help",
          text: "Use a short label such as 原案、黑化線、和解線。留空即可移除名稱。"
        });

        const inputWrap = contentEl.createDiv({
          cls: "story-version-rename-input"
        });

        const input = new TextComponent(inputWrap);
        input.setValue(
          activeVersion && typeof activeVersion.label === "string"
            ? activeVersion.label
            : ""
        );
        input.inputEl.placeholder = "Version label";
        input.inputEl.focus();
        input.inputEl.select();

        const actions = contentEl.createDiv({
          cls: "story-version-rename-actions"
        });

        const cancel = actions.createEl("button", { text: "Cancel" });
        cancel.addEventListener("click", () => this.close());

        const save = actions.createEl("button", {
          text: "Save",
          cls: "mod-cta"
        });

        const commit = async () => {
          activeVersion.label = input.getValue().trim();
          await plugin.persistState();
          plugin.decorate(canvas, path);
          window.setTimeout(() => plugin.injectPopupToolbar(canvas, path), 0);
          this.close();
        };

        save.addEventListener("click", () => void commit());
        input.inputEl.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            void commit();
          }
        });
      }

      onClose() {
        this.contentEl.empty();
      }
    }

    new RenameVersionModal(this.app).open();
  }

  moveVersionInState(versionState, fromIndex, delta) {
    if (!versionState || !Array.isArray(versionState.versions)) return false;

    const versions = versionState.versions;
    if (!versions.length) return false;

    const toIndex = fromIndex + delta;
    if (
      fromIndex < 0 ||
      fromIndex >= versions.length ||
      toIndex < 0 ||
      toIndex >= versions.length
    ) {
      return false;
    }

    const activeVersion = versions[
      Math.max(0, Math.min(versionState.active || 0, versions.length - 1))
    ];
    const activeId = activeVersion && activeVersion.id;

    const [moved] = versions.splice(fromIndex, 1);
    versions.splice(toIndex, 0, moved);

    if (activeId) {
      const newActive = versions.findIndex((version) => version.id === activeId);
      versionState.active = newActive >= 0 ? newActive : 0;
    } else {
      versionState.active = Math.max(
        0,
        Math.min(versionState.active || 0, versions.length - 1)
      );
    }

    return true;
  }

  addVersionReorderControls(container, index, count, onMove) {
    const controls = container.createDiv({
      cls: "story-version-reorder-controls"
    });

    const up = controls.createEl("button", {
      cls: "clickable-icon story-version-reorder-button"
    });
    up.type = "button";
    up.setAttribute("aria-label", "Move version earlier");
    up.setAttribute("title", "Move version earlier");
    setIcon(up, "chevron-up");
    up.disabled = index <= 0;

    const down = controls.createEl("button", {
      cls: "clickable-icon story-version-reorder-button"
    });
    down.type = "button";
    down.setAttribute("aria-label", "Move version later");
    down.setAttribute("title", "Move version later");
    setIcon(down, "chevron-down");
    down.disabled = index >= count - 1;

    up.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!up.disabled) onMove(-1);
    });

    down.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!down.disabled) onMove(1);
    });

    return controls;
  }

  versionPreviewText(text) {
    const normalized = String(text || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!normalized) return "(blank version)";
    return normalized.length > 120
      ? `${normalized.slice(0, 120)}…`
      : normalized;
  }

  async switchCardVersionToIndex(canvas, path, nodeId, index) {
    let versionState = this.getCardVersionState(path, nodeId, false);
    if (!versionState || !versionState.versions.length) return;

    versionState = this.syncActiveCardVersion(canvas, path, nodeId) || versionState;
    const target = Math.max(0, Math.min(index, versionState.versions.length - 1));
    versionState.active = target;

    await this.persistState();
    this.applyActiveCardVersion(canvas, path, nodeId);
  }

  openCardVersionOverview(canvas, path, nodeId) {
    const versionState = this.getCardVersionState(path, nodeId, false);
    if (!versionState) {
      new Notice("This card does not have version history yet.");
      return;
    }

    this.syncActiveCardVersion(canvas, path, nodeId);
    void this.persistState();

    const plugin = this;

    class VersionOverviewModal extends Modal {
      onOpen() {
        this.modalEl.addClass("story-version-overview-modal");
        this.render();
      }

      render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("story-version-overview");

        const header = contentEl.createDiv({
          cls: "story-version-overview-header"
        });

        header.createEl("h2", { text: "Card versions" });

        header.createDiv({
          cls: "story-version-overview-count",
          text: `${versionState.versions.length} versions`
        });

        const list = contentEl.createDiv({
          cls: "story-version-overview-list"
        });

        versionState.versions.forEach((version, index) => {
          const row = list.createDiv({
            cls: "story-version-overview-item"
          });

          if (index === versionState.active) {
            row.addClass("is-active");
          }

          const meta = row.createDiv({
            cls: "story-version-overview-meta"
          });

          const titleWrap = meta.createDiv({
            cls: "story-version-overview-title-wrap"
          });

          titleWrap.createSpan({
            cls: "story-version-overview-number",
            text: plugin.versionDisplayName(version, index)
          });

          if (index === versionState.active) {
            titleWrap.createSpan({
              cls: "story-version-overview-active",
              text: "Current"
            });
          }

          plugin.addVersionReorderControls(
            meta,
            index,
            versionState.versions.length,
            async (delta) => {
              if (!plugin.moveVersionInState(versionState, index, delta)) return;
              await plugin.persistState();
              plugin.decorate(canvas, path);
              window.setTimeout(
                () => plugin.injectPopupToolbar(canvas, path),
                0
              );
              this.render();
            }
          );

          row.createDiv({
            cls: "story-version-overview-preview",
            text: plugin.versionPreviewText(version.text)
          });

          row.addEventListener("click", async () => {
            await plugin.switchCardVersionToIndex(
              canvas,
              path,
              nodeId,
              index
            );
            this.close();
          });
        });
      }

      onClose() {
        this.modalEl.removeClass("story-version-overview-modal");
        this.contentEl.empty();
      }
    }

    new VersionOverviewModal(this.app).open();
  }

  isManagedFrame(path, nodeId) {
    const state = this.canvasState(path, false);
    return !!(state && state.frames && state.frames[nodeId]);
  }

  parentFrames(path, nodeId) {
    const state = this.canvasState(path, false);
    if (!state) return [];
    return Object.values(state.frames).filter((frame) => frame.children.includes(nodeId));
  }

  frameContainsFrame(path, ancestorGroupId, candidateGroupId, visited = new Set()) {
    if (ancestorGroupId === candidateGroupId) return true;
    if (visited.has(ancestorGroupId)) return false;
    visited.add(ancestorGroupId);

    const state = this.canvasState(path, false);
    const frame = state && state.frames[ancestorGroupId];
    if (!frame) return false;

    for (const childId of frame.children) {
      if (childId === candidateGroupId) return true;
      if (state.frames[childId] && this.frameContainsFrame(path, childId, candidateGroupId, visited)) {
        return true;
      }
    }
    return false;
  }

  canInsertNodeIntoFrame(path, draggedId, targetGroupId) {
    if (draggedId === targetGroupId) return false;

    // Normal cards can always enter a managed frame.
    if (!this.isManagedFrame(path, draggedId)) return true;

    // A managed frame cannot be placed inside one of its own descendants.
    return !this.frameContainsFrame(path, draggedId, targetGroupId);
  }

  translateNodeTree(canvas, path, nodeId, x, y, visited = new Set()) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const data = this.liveNodeData(canvas, nodeId);
    if (!data) return;

    const dx = x - data.x;
    const dy = y - data.y;

    this.patchLiveNode(canvas, nodeId, { x, y });

    // Keep the geometry watcher snapshot synchronized with plugin-driven moves.
    // Otherwise the next scan could mistake this move for a native Canvas move
    // and translate a nested subtree twice.
    this.nodeGeometry.set(`${path}::${nodeId}`, {
      x: Number(x) || 0,
      y: Number(y) || 0,
      width: Number(data.width) || 0,
      height: Number(data.height) || 0
    });

    const state = this.canvasState(path, false);
    const childFrame = state && state.frames[nodeId];
    if (!childFrame || (!dx && !dy)) return;

    // Canvas groups are not reliable transform containers when moved via private API.
    // Translate the whole managed subtree explicitly so nested cards stay inside it.
    for (const childId of childFrame.children) {
      const child = this.liveNodeData(canvas, childId);
      if (!child) continue;
      this.translateNodeTree(
        canvas,
        path,
        childId,
        child.x + dx,
        child.y + dy,
        visited
      );
    }
  }

  captureFrameRelativeGeometry(canvas, path, groupId) {
    if (!this.isManagedFrame(path, groupId)) return null;

    const group = this.liveNodeData(canvas, groupId);
    const state = this.canvasState(path, false);
    const frame = state && state.frames && state.frames[groupId];
    if (!group || !frame) return null;

    const snapshot = {
      children: new Map()
    };

    for (const childId of frame.children || []) {
      const child = this.liveNodeData(canvas, childId);
      if (!child) continue;

      snapshot.children.set(childId, {
        relX: (Number(child.x) || 0) - (Number(group.x) || 0),
        relY: (Number(child.y) || 0) - (Number(group.y) || 0)
      });
    }

    this.frameRelativeGeometry.set(`${path}::${groupId}`, snapshot);
    return snapshot;
  }

  restoreFrameRelativeGeometry(canvas, path, groupId, snapshot = null) {
    if (!this.isManagedFrame(path, groupId)) return;

    const group = this.liveNodeData(canvas, groupId);
    const state = this.canvasState(path, false);
    const frame = state && state.frames && state.frames[groupId];
    if (!group || !frame) return;

    const source =
      snapshot ||
      this.frameRelativeGeometry.get(`${path}::${groupId}`);

    if (!source || !source.children) {
      this.captureFrameRelativeGeometry(canvas, path, groupId);
      return;
    }

    const visited = new Set([groupId]);

    for (const childId of frame.children || []) {
      const stored = source.children.get(childId);
      if (!stored) continue;

      this.translateNodeTree(
        canvas,
        path,
        childId,
        (Number(group.x) || 0) + stored.relX,
        (Number(group.y) || 0) + stored.relY,
        visited
      );
    }

    this.captureFrameRelativeGeometry(canvas, path, groupId);
  }

  refreshAllFrameRelativeGeometry(canvas, path) {
    const state = this.canvasState(path, false);
    if (!state || !state.frames) return;

    for (const frame of Object.values(state.frames)) {
      this.captureFrameRelativeGeometry(canvas, path, frame.groupId);
    }
  }

  reflowParentChain(canvas, path, childNodeId, visited = new Set()) {
    if (visited.has(childNodeId)) return;
    visited.add(childNodeId);

    for (const parent of this.parentFrames(path, childNodeId)) {
      if (visited.has(parent.groupId)) continue;
      this.reflowFrame(canvas, path, parent, false, false, true);
      this.reflowParentChain(canvas, path, parent.groupId, visited);
    }
  }

  bounds(nodes) {
    const left = Math.min(...nodes.map((n) => n.x));
    const top = Math.min(...nodes.map((n) => n.y));
    const right = Math.max(...nodes.map((n) => n.x + n.width));
    const bottom = Math.max(...nodes.map((n) => n.y + n.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  managedFrameMarker(canvas, path, frame) {
    const versionState =
      this.getFrameVersionState(
        path,
        frame.groupId,
        false
      );

    const activeIndex =
      versionState &&
      versionState.versions &&
      versionState.versions.length
        ? Math.max(
            0,
            Math.min(
              versionState.active || 0,
              versionState.versions.length - 1
            )
          )
        : 0;

    const activeVersion =
      versionState &&
      versionState.versions &&
      versionState.versions[activeIndex];

    const relativeGeometry = {};
    const group =
      this.liveNodeData(
        canvas,
        frame.groupId
      );

    if (group) {
      for (const childId of frame.children || []) {
        const child =
          this.liveNodeData(
            canvas,
            childId
          );
        if (!child) continue;

        relativeGeometry[childId] = {
          x: child.x - group.x,
          y: child.y - group.y,
          width: child.width,
          height: child.height
        };
      }
    }

    return {
      managed: true,
      schema: 2,
      direction: frame.direction || "vertical",
      children: [...(frame.children || [])],
      gap: Number.isFinite(frame.gap)
        ? frame.gap
        : this.defaultGap(),
      padding: Number.isFinite(frame.padding)
        ? frame.padding
        : this.defaultPadding(),
      sizeMode: frame.sizeMode || "free",
      fixedSizes: clone(frame.fixedSizes || {}),
      layoutPaused: !!frame.layoutPaused,
      nestedSpacing: Number.isFinite(frame.nestedSpacing)
        ? frame.nestedSpacing
        : this.defaultNestedSpacing(),
      nestedInset: Number.isFinite(frame.nestedInset)
        ? frame.nestedInset
        : this.defaultNestedInset(),
      activeVersion: activeIndex,
      crossAxisRatios:
        activeVersion &&
        activeVersion.crossAxisRatios
          ? clone(activeVersion.crossAxisRatios)
          : this.captureFrameCrossAxisRatios(
              canvas,
              path,
              frame
            ),
      relativeGeometry
    };
  }

  stampManagedFrameMarker(canvas, path, frame) {
    if (
      !canvas ||
      !path ||
      !frame ||
      !frame.groupId
    ) {
      return false;
    }

    const marker =
      this.managedFrameMarker(
        canvas,
        path,
        frame
      );

    const node =
      canvas.nodes &&
      canvas.nodes.get(frame.groupId);

    let liveWritten = false;

    if (
      node &&
      typeof node.getData === "function" &&
      typeof node.setData === "function"
    ) {
      const next = {
        ...node.getData(),
        storyCanvasLayoutFrame: marker
      };

      node.setData(next);
      liveWritten = true;

      const nodeCanvas =
        node.canvas &&
        typeof node.canvas.requestSave === "function"
          ? node.canvas
          : canvas;

      if (
        nodeCanvas &&
        typeof nodeCanvas.requestSave === "function"
      ) {
        nodeCanvas.requestSave(false);
      }
    }

    // Verify that the canonical serialized Canvas data contains the marker.
    // Some Canvas lifecycle states accept node.setData() in memory but have not
    // yet reflected that field into canvas.getData(). In that case explicitly
    // patch the serialized node and request another save.
    if (typeof canvas.getData === "function") {
      let data = null;

      try {
        data = canvas.getData();
      } catch (_) {
        data = null;
      }

      if (data && Array.isArray(data.nodes)) {
        const serialized =
          data.nodes.find(
            (item) =>
              item &&
              item.id === frame.groupId
          );

        const serializedMarker =
          serialized &&
          serialized.storyCanvasLayoutFrame;

        if (
          !serializedMarker ||
          serializedMarker.managed !== true
        ) {
          const nextData = clone(data);
          const target =
            nextData.nodes.find(
              (item) =>
                item &&
                item.id === frame.groupId
            );

          if (target) {
            target.storyCanvasLayoutFrame =
              clone(marker);

            if (
              typeof canvas.setData === "function"
            ) {
              canvas.setData(nextData);
            }

            if (
              typeof canvas.requestSave === "function"
            ) {
              canvas.requestSave(false);
            }

            return true;
          }
        } else {
          return true;
        }
      }
    }

    return liveWritten;
  }

  flushManagedFrameIdentity(canvas, path, frame) {
    const written =
      this.stampManagedFrameMarker(
        canvas,
        path,
        frame
      );

    if (
      written &&
      typeof canvas.requestSave === "function"
    ) {
      canvas.requestSave(false);
    }

    return written;
  }

  clearManagedFrameMarker(canvas, groupId) {
    if (!canvas || !groupId) return false;

    return this.patchLiveNode(
      canvas,
      groupId,
      { storyCanvasLayoutFrame: null }
    );
  }

  recoverManagedFramesFromCanvasMarkers(canvas, path) {
    if (
      !this.canvasHydrationReady(canvas, path) ||
      typeof canvas.getData !== "function"
    ) {
      return false;
    }

    let data = null;
    try {
      data = canvas.getData();
    } catch (_) {
      return false;
    }

    if (!data || !Array.isArray(data.nodes)) {
      return false;
    }

    const state = this.canvasState(path, true);
    let recovered = 0;

    for (const node of data.nodes) {
      if (!node || node.type !== "group" || !node.id) continue;

      const marker = node.storyCanvasLayoutFrame;
      if (!marker || marker.managed !== true) continue;

      if (state.frames[node.id]) {
        const existing = state.frames[node.id];

        // The marker in the .canvas node is the durable identity source.
        // Refresh only identity/layout fields that are safe to mirror.
        existing.groupId = node.id;

        if (
          marker.direction === "vertical" ||
          marker.direction === "horizontal"
        ) {
          existing.direction = marker.direction;
        }

        if (Array.isArray(marker.children)) {
          existing.children = [...marker.children];
        }

        if (Number.isFinite(marker.gap)) {
          existing.gap = marker.gap;
        }
        if (Number.isFinite(marker.padding)) {
          existing.padding = marker.padding;
        }
        if (Number.isFinite(marker.nestedSpacing)) {
          existing.nestedSpacing = marker.nestedSpacing;
        }
        if (Number.isFinite(marker.nestedInset)) {
          existing.nestedInset = marker.nestedInset;
        }

        existing.layoutPaused =
          !!marker.layoutPaused;
      } else {
        state.frames[node.id] = {
          groupId: node.id,
          direction:
            marker.direction === "horizontal"
              ? "horizontal"
              : "vertical",
          children: Array.isArray(marker.children)
            ? [...marker.children]
            : [],
          gap: Number.isFinite(marker.gap)
            ? marker.gap
            : this.defaultGap(),
          padding: Number.isFinite(marker.padding)
            ? marker.padding
            : this.defaultPadding(),
          sizeMode: marker.sizeMode || "free",
          fixedSizes:
            marker.fixedSizes &&
            typeof marker.fixedSizes === "object"
              ? clone(marker.fixedSizes)
              : {},
          layoutPaused: !!marker.layoutPaused,
          nestedSpacing:
            Number.isFinite(marker.nestedSpacing)
              ? marker.nestedSpacing
              : this.defaultNestedSpacing(),
          nestedInset:
            Number.isFinite(marker.nestedInset)
              ? marker.nestedInset
              : this.defaultNestedInset()
        };

        if (
          marker.crossAxisRatios &&
          typeof marker.crossAxisRatios === "object"
        ) {
          state.frameVersions[node.id] = {
            active: 0,
            visibleDetached: [],
            versions: [
              {
                id: uid(),
                children: Array.isArray(marker.children)
                  ? [...marker.children]
                  : [],
                direction:
                  marker.direction === "horizontal"
                    ? "horizontal"
                    : "vertical",
                gap: Number.isFinite(marker.gap)
                  ? marker.gap
                  : this.defaultGap(),
                padding: Number.isFinite(marker.padding)
                  ? marker.padding
                  : this.defaultPadding(),
                nestedSpacing:
                  Number.isFinite(marker.nestedSpacing)
                    ? marker.nestedSpacing
                    : this.defaultNestedSpacing(),
                nestedInset:
                  Number.isFinite(marker.nestedInset)
                    ? marker.nestedInset
                    : this.defaultNestedInset(),
                layoutPaused: !!marker.layoutPaused,
                crossAxisRatios:
                  clone(marker.crossAxisRatios),
                label: "",
                description: ""
              }
            ]
          };
        }

        recovered += 1;
      }
    }

    if (recovered) {
      void this.persistState();
      console.info(
        `[Story Canvas Layout] Recovered ${recovered} managed Frame marker(s) from Canvas JSON.`,
        path
      );
    }

    return true;
  }

  restoreFrameRuntimeFromMarker(
    canvas,
    path,
    frame
  ) {
    if (
      !canvas ||
      !frame ||
      typeof canvas.getData !== "function"
    ) {
      return false;
    }

    let data = null;
    try {
      data = canvas.getData();
    } catch (_) {
      return false;
    }

    if (!data || !Array.isArray(data.nodes)) {
      return false;
    }

    const serializedGroup =
      data.nodes.find(
        (node) =>
          node &&
          node.id === frame.groupId
      );

    const marker =
      serializedGroup &&
      serializedGroup.storyCanvasLayoutFrame;

    if (
      !marker ||
      marker.managed !== true
    ) {
      return false;
    }

    const group =
      this.liveNodeData(
        canvas,
        frame.groupId
      );
    if (!group) return false;

    const relative =
      marker.relativeGeometry &&
      typeof marker.relativeGeometry === "object"
        ? marker.relativeGeometry
        : null;

    if (relative) {
      for (const childId of frame.children || []) {
        const saved = relative[childId];
        const child =
          this.liveNodeData(
            canvas,
            childId
          );

        if (!saved || !child) continue;

        const targetX =
          group.x + Number(saved.x || 0);
        const targetY =
          group.y + Number(saved.y || 0);

        const dx = targetX - child.x;
        const dy = targetY - child.y;

        if (
          Math.abs(dx) > 0.5 ||
          Math.abs(dy) > 0.5
        ) {
          this.translateNodeTree(
            canvas,
            path,
            childId,
            dx,
            dy
          );
        }
      }
    }

    const versionState =
      this.getFrameVersionState(
        path,
        frame.groupId,
        false
      );

    if (
      versionState &&
      versionState.versions &&
      versionState.versions.length
    ) {
      const active = Math.max(
        0,
        Math.min(
          Number.isFinite(marker.activeVersion)
            ? marker.activeVersion
            : versionState.active || 0,
          versionState.versions.length - 1
        )
      );

      versionState.active = active;

      const version =
        versionState.versions[active];

      if (
        marker.crossAxisRatios &&
        typeof marker.crossAxisRatios === "object"
      ) {
        version.crossAxisRatios =
          clone(marker.crossAxisRatios);
      }
    }

    return true;
  }

  ensureManagedFrameRuntime(canvas, path) {
    if (!this.canvasHydrationReady(canvas, path)) {
      return false;
    }

    this.recoverManagedFramesFromCanvasMarkers(
      canvas,
      path
    );

    const state = this.canvasState(path, false);
    if (!state || !state.frames) return true;

    const frames = Object.values(state.frames);

    for (const frame of frames) {
      const group =
        this.liveNodeData(
          canvas,
          frame.groupId
        );

      if (!group || group.type !== "group") {
        continue;
      }

      this.restoreFrameRuntimeFromMarker(
        canvas,
        path,
        frame
      );
    }

    const depthOf = (frame) =>
      this.parentFrames(
        path,
        frame.groupId
      ).length;

    frames
      .slice()
      .sort((a, b) => depthOf(b) - depthOf(a))
      .forEach((frame) => {
        const group =
          this.liveNodeData(
            canvas,
            frame.groupId
          );

        if (!group || group.type !== "group") {
          return;
        }

        const versionState =
          this.getFrameVersionState(
            path,
            frame.groupId,
            false
          );

        const activeVersion =
          versionState &&
          versionState.versions &&
          versionState.versions[
            Math.max(
              0,
              Math.min(
                versionState.active || 0,
                versionState.versions.length - 1
              )
            )
          ];

        this.reflowFrame(
          canvas,
          path,
          frame,
          false,
          false,
          true,
          activeVersion &&
          activeVersion.crossAxisRatios
            ? activeVersion.crossAxisRatios
            : {}
        );

        this.flushManagedFrameIdentity(
          canvas,
          path,
          frame
        );
      });

    this.updateFrameVersionVisibility(
      canvas,
      path
    );
    this.resetGeometryBaselineForPath(
      canvas,
      path
    );
    this.decorate(canvas, path);

    return true;
  }

  async createFrame(canvas, path, direction, selected) {
    if (!selected.length) return;

    const ordered = [...selected].sort((a, b) =>
      direction === "vertical" ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y
    );

    const b = this.bounds(ordered);
    const defaultPadding = this.defaultPadding();
    const groupData = await this.createNativeGroup(canvas, {
      x: b.x - defaultPadding,
      y: b.y - defaultPadding,
      width: Math.max(MIN_GROUP_WIDTH, b.width + defaultPadding * 2),
      height: Math.max(MIN_GROUP_HEIGHT, b.height + defaultPadding * 2),
      label: this.frameLabel(direction, ordered.length)
    });

    if (!groupData) {
      new Notice("Could not create layout frame on this Obsidian version.");
      return;
    }

    const state = this.canvasState(path, true);
    state.frames[groupData.id] = {
      groupId: groupData.id,
      direction,
      children: ordered.map((n) => n.id),
      gap: this.defaultGap(),
      padding: this.defaultPadding(),
      sizeMode: "free",
      fixedSizes: {},
      layoutPaused: false,
      nestedSpacing: this.defaultNestedSpacing(),
      nestedInset: this.defaultNestedInset()
    };

    this.flushManagedFrameIdentity(
      canvas,
      path,
      state.frames[groupData.id]
    );
    await this.persistState();

    window.setTimeout(() => {
      this.reflowFrame(
        canvas,
        path,
        state.frames[groupData.id]
      );
      this.flushManagedFrameIdentity(
        canvas,
        path,
        state.frames[groupData.id]
      );
      this.decorate(canvas, path);
    }, 30);

    new Notice(`Created ${direction} layout frame`);
  }

  async createNativeGroup(canvas, data) {
    if (typeof canvas.createGroupNode === "function") {
      try {
        const node = canvas.createGroupNode({
          pos: { x: data.x, y: data.y },
          size: { width: data.width, height: data.height },
          label: data.label
        });
        if (node && typeof node.getData === "function") {
          canvas.requestSave(false);
          return node.getData();
        }
      } catch (err) {
        console.warn("[Story Canvas Layout] createGroupNode failed; using JSON fallback.", err);
      }
    }

    const canvasData = clone(canvas.getData());
    const group = {
      id: uid(),
      type: "group",
      x: data.x,
      y: data.y,
      width: data.width,
      height: data.height,
      label: data.label
    };
    canvasData.nodes.unshift(group);
    canvas.setData(canvasData);
    canvas.requestSave(false);
    return group;
  }

  async createEmptyFrameAtCenter(canvas, path, direction) {
    let pos = null;
    if (typeof canvas.posCenter === "function") {
      try { pos = canvas.posCenter(); } catch (_) {}
    }
    if (!pos) pos = { x: 0, y: 0 };

    await this.createEmptyFrame(canvas, path, direction, pos.x, pos.y);
  }

  async createEmptyFrame(canvas, path, direction, centerX, centerY) {
    const width = direction === "vertical" ? 360 : 520;
    const height = direction === "vertical" ? 520 : 260;
    const groupData = await this.createNativeGroup(canvas, {
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      height,
      label: this.frameLabel(direction, 0)
    });
    if (!groupData) return;

    const state = this.canvasState(path, true);
    state.frames[groupData.id] = {
      groupId: groupData.id,
      direction,
      children: [],
      gap: this.defaultGap(),
      padding: this.defaultPadding(),
      sizeMode: "free",
      fixedSizes: {},
      layoutPaused: false,
      nestedSpacing: this.defaultNestedSpacing(),
      nestedInset: this.defaultNestedInset()
    };
    this.flushManagedFrameIdentity(
      canvas,
      path,
      state.frames[groupData.id]
    );
    await this.persistState();
    canvas.requestSave(false);
    this.decorate(canvas, path);
  }

  managedParentFramesForNode(path, nodeId) {
    const state = this.canvasState(path, false);
    if (!state || !state.frames) return [];

    return Object.values(state.frames).filter(
      (frame) =>
        Array.isArray(frame.children) &&
        frame.children.includes(nodeId)
    );
  }

  async detachNodeFromManagedFrames(
    canvas,
    path,
    nodeId
  ) {
    if (!canvas || !path || !nodeId) return false;

    const state = this.canvasState(path, false);
    if (!state || !state.frames) return false;

    const parents =
      this.managedParentFramesForNode(
        path,
        nodeId
      );

    if (!parents.length) {
      new Notice(
        "This Canvas item is not inside a Story Layout Frame."
      );
      return false;
    }

    const affected = new Set();

    for (const frame of parents) {
      frame.children =
        (frame.children || [])
          .filter((id) => id !== nodeId);

      if (frame.fixedSizes) {
        delete frame.fixedSizes[nodeId];
      }

      affected.add(frame.groupId);

      const versionState =
        this.getFrameVersionState(
          path,
          frame.groupId,
          false
        );

      if (
        versionState &&
        versionState.versions &&
        versionState.versions.length
      ) {
        const active = Math.max(
          0,
          Math.min(
            versionState.active || 0,
            versionState.versions.length - 1
          )
        );

        const activeVersion =
          versionState.versions[active];

        activeVersion.children =
          (activeVersion.children || [])
            .filter((id) => id !== nodeId);

        if (activeVersion.crossAxisRatios) {
          delete activeVersion.crossAxisRatios[nodeId];
        }

        versionState.visibleDetached =
          Array.from(
            new Set([
              ...(versionState.visibleDetached || []),
              nodeId
            ])
          );
      }
    }

    for (const groupId of affected) {
      const frame = state.frames[groupId];
      if (!frame) continue;

      this.reflowFrame(
        canvas,
        path,
        frame,
        false,
        true,
        true
      );

      this.syncActiveFrameVersion(
        path,
        groupId,
        canvas
      );

      this.flushManagedFrameIdentity(
        canvas,
        path,
        frame
      );
    }

    this.updateFrameVersionVisibility(
      canvas,
      path
    );
    this.resetGeometryBaselineForPath(
      canvas,
      path
    );

    canvas.requestSave(false);
    await this.persistState();

    this.decorate(canvas, path);

    new Notice(
      parents.length === 1
        ? "Detached item from Story Layout Frame."
        : `Detached item from ${parents.length} Story Layout Frames.`
    );

    return true;
  }

  async stopManagingFrame(canvas, path, frame) {
    const state = this.canvasState(path, false);
    if (!state) return;
    delete state.frames[frame.groupId];
    if (state.frameVersions && state.frameVersions[frame.groupId]) {
      delete state.frameVersions[frame.groupId];
    }

    this.clearManagedFrameMarker(
      canvas,
      frame.groupId
    );

    await this.persistState();
    canvas.requestSave(false);
    this.updateFrameVersionVisibility(canvas, path);
    this.decorate(canvas, path);
    new Notice("Layout management removed. Group and cards were kept.");
  }

  frameLabel(direction, _count) {
    return direction === "vertical" ? "Vertical layout" : "Horizontal layout";
  }

  async persistAndReflow(canvas, path, frame) {
    this.syncActiveFrameVersion(
      path,
      frame.groupId,
      canvas
    );

    this.stampManagedFrameMarker(canvas, path, frame);

    await this.persistState();

    this.reflowFrame(
      canvas,
      path,
      frame,
      true,
      true,
      true
    );

    this.syncActiveFrameVersion(
      path,
      frame.groupId,
      canvas
    );

    this.stampManagedFrameMarker(canvas, path, frame);

    await this.persistState();
    this.updateFrameVersionVisibility(
      canvas,
      path
    );
  }

  async reflowAll(canvas, path) {
    const state = this.canvasState(path, false);
    if (!state) return;

    // Remove/rebuild version badges so they always reflect the current active index.
    for (const node of canvas.nodes.values()) {
      if (!node.nodeEl) continue;
      for (const badge of node.nodeEl.querySelectorAll(".story-card-version-badge")) {
        badge.remove();
      }
    }

    if (state.cardVersions) {
      for (const [nodeId, versionState] of Object.entries(state.cardVersions)) {
        const node = canvas.nodes.get(nodeId);
        if (!node || !node.nodeEl || !versionState || !versionState.versions || !versionState.versions.length) continue;

        const data = typeof node.getData === "function" ? node.getData() : null;
        if (!data || data.type !== "text") continue;

        versionState.active = Math.max(
          0,
          Math.min(versionState.active || 0, versionState.versions.length - 1)
        );

        const badge = document.createElement("div");
        badge.className = "story-card-version-badge";
        badge.textContent = `${versionState.active + 1}/${versionState.versions.length}`;
        const activeVersion = versionState.versions[versionState.active];
        const labelSuffix =
          activeVersion && activeVersion.label ? ` — ${activeVersion.label}` : "";
        badge.setAttribute(
          "aria-label",
          `Version ${versionState.active + 1} of ${versionState.versions.length}${labelSuffix}`
        );
        badge.setAttribute(
          "title",
          activeVersion && activeVersion.label
            ? activeVersion.label
            : `Version ${versionState.active + 1}/${versionState.versions.length}`
        );
        node.nodeEl.appendChild(badge);
      }
    }

    for (const frame of Object.values(state.frames)) {
      this.reflowFrame(canvas, path, frame, false);
    }
    canvas.requestSave(false);
    await this.persistState();
    this.decorate(canvas, path);
  }

  liveNodeData(canvas, id) {
    const node = canvas.nodes && canvas.nodes.get(id);
    return node && typeof node.getData === "function" ? node.getData() : null;
  }

  patchLiveNode(canvas, id, patch) {
    const node = canvas.nodes && canvas.nodes.get(id);
    if (!node || typeof node.getData !== "function" || typeof node.setData !== "function") return false;
    const next = { ...node.getData(), ...patch };
    node.setData(next);
    return true;
  }

  reflowFrame(
    canvas,
    path,
    frame,
    save = true,
    propagate = true,
    preserveCrossAxis = false,
    crossAxisRatioOverride = null
  ) {
    if (frame.layoutPaused) {
      if (save) canvas.requestSave(false);
      this.decorate(canvas, path);
      return true;
    }

    this.applySizeMode(canvas, frame);

    const group = this.liveNodeData(canvas, frame.groupId);
    if (!group) {
      // Never erase persisted managed-Frame identity just because the live
      // Canvas node has not hydrated yet. Manual Repair owns destructive cleanup.
      return false;
    }

    const children = [];
    for (const id of frame.children || []) {
      const nodeData = this.liveNodeData(canvas, id);

      if (!nodeData) {
        // Do not partially reflow and do not rewrite frame.children.
        return false;
      }

      if (
        nodeData.type === "group" &&
        !this.isManagedFrame(path, id)
      ) {
        continue;
      }

      children.push(nodeData);
    }

    const p = frame.padding;
    const gap = frame.gap;
    let groupPatch = {};

    if (children.length === 0) {
      this.patchLiveNode(canvas, frame.groupId, groupPatch);
      this.stampManagedFrameMarker(canvas, path, frame);
      this.captureFrameRelativeGeometry(canvas, path, frame.groupId);
      if (propagate) {
        this.reflowParentChain(canvas, path, frame.groupId);
      }
      if (save) canvas.requestSave(false);
      this.decorate(canvas, path);
      return true;
    }

    if (frame.direction === "vertical") {
      const nestedInset = Number(frame.nestedInset) || 0;
      const nestedSpacing = Number(frame.nestedSpacing) || 0;

      const effectiveWidths = children.map((n) =>
        this.isManagedFrame(path, n.id) ? n.width + nestedInset : n.width
      );
      const contentWidth = Math.max(...effectiveWidths);

      const newGroupWidth = Math.max(
        MIN_GROUP_WIDTH,
        contentWidth + p * 2
      );

      const baseHeight =
        children.reduce((sum, n) => sum + n.height, 0) +
        gap * Math.max(0, children.length - 1);

      const nestedExtra =
        children.reduce((sum, n, index) => {
          if (!this.isManagedFrame(path, n.id)) return sum;
          let extra = 0;
          if (index > 0) extra += nestedSpacing;
          if (index < children.length - 1) extra += nestedSpacing;
          return sum + extra;
        }, 0);

      const newGroupHeight = Math.max(
        MIN_GROUP_HEIGHT,
        baseHeight + nestedExtra + p * 2
      );

      groupPatch.width = newGroupWidth;
      groupPatch.height = newGroupHeight;

      const crossRatios = new Map();

      if (preserveCrossAxis) {
        for (const child of children) {
          if (
            crossAxisRatioOverride &&
            Number.isFinite(Number(crossAxisRatioOverride[child.id]))
          ) {
            crossRatios.set(
              child.id,
              this.normalizeCrossAxisRatio(
                crossAxisRatioOverride[child.id]
              )
            );
            continue;
          }

          const isNested = this.isManagedFrame(path, child.id);
          const oldStart =
            group.x + p + (isNested ? nestedInset : 0);
          const oldEnd =
            group.x + group.width - p - child.width;
          const range = oldEnd - oldStart;

          const ratio =
            range > 0.5
              ? Math.max(
                  0,
                  Math.min(1, (child.x - oldStart) / range)
                )
              : 0;

          crossRatios.set(child.id, ratio);
        }
      }

      let y = group.y + p;

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const isNested = this.isManagedFrame(path, child.id);

        if (isNested && i > 0) {
          y += nestedSpacing;
        }

        const startX =
          group.x + p + (isNested ? nestedInset : 0);

        let targetX = startX;

        if (preserveCrossAxis) {
          const endX =
            group.x + newGroupWidth - p - child.width;
          const range = Math.max(0, endX - startX);
          const ratio = crossRatios.get(child.id) || 0;
          targetX = startX + range * ratio;
        }

        this.translateNodeTree(
          canvas,
          path,
          child.id,
          targetX,
          y
        );

        y += child.height + gap;

        if (isNested && i < children.length - 1) {
          y += nestedSpacing;
        }
      }
    } else {
      const nestedInset = Number(frame.nestedInset) || 0;
      const nestedSpacing = Number(frame.nestedSpacing) || 0;

      const effectiveHeights = children.map((n) =>
        this.isManagedFrame(path, n.id) ? n.height + nestedInset : n.height
      );
      const contentHeight = Math.max(...effectiveHeights);

      const baseWidth =
        children.reduce((sum, n) => sum + n.width, 0) +
        gap * Math.max(0, children.length - 1);

      const nestedExtra =
        children.reduce((sum, n, index) => {
          if (!this.isManagedFrame(path, n.id)) return sum;
          let extra = 0;
          if (index > 0) extra += nestedSpacing;
          if (index < children.length - 1) extra += nestedSpacing;
          return sum + extra;
        }, 0);

      const newGroupWidth = Math.max(
        MIN_GROUP_WIDTH,
        baseWidth + nestedExtra + p * 2
      );

      const newGroupHeight = Math.max(
        MIN_GROUP_HEIGHT,
        contentHeight + p * 2
      );

      groupPatch.width = newGroupWidth;
      groupPatch.height = newGroupHeight;

      const crossRatios = new Map();

      if (preserveCrossAxis) {
        for (const child of children) {
          if (
            crossAxisRatioOverride &&
            Number.isFinite(Number(crossAxisRatioOverride[child.id]))
          ) {
            crossRatios.set(
              child.id,
              this.normalizeCrossAxisRatio(
                crossAxisRatioOverride[child.id]
              )
            );
            continue;
          }

          const isNested = this.isManagedFrame(path, child.id);
          const oldStart =
            group.y + p + (isNested ? nestedInset : 0);
          const oldEnd =
            group.y + group.height - p - child.height;
          const range = oldEnd - oldStart;

          const ratio =
            range > 0.5
              ? Math.max(
                  0,
                  Math.min(1, (child.y - oldStart) / range)
                )
              : 0;

          crossRatios.set(child.id, ratio);
        }
      }

      let x = group.x + p;

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const isNested = this.isManagedFrame(path, child.id);

        if (isNested && i > 0) {
          x += nestedSpacing;
        }

        const startY =
          group.y + p + (isNested ? nestedInset : 0);

        let targetY = startY;

        if (preserveCrossAxis) {
          const endY =
            group.y + newGroupHeight - p - child.height;
          const range = Math.max(0, endY - startY);
          const ratio = crossRatios.get(child.id) || 0;
          targetY = startY + range * ratio;
        }

        this.translateNodeTree(
          canvas,
          path,
          child.id,
          x,
          targetY
        );

        x += child.width + gap;

        if (isNested && i < children.length - 1) {
          x += nestedSpacing;
        }
      }
    }

    this.patchLiveNode(canvas, frame.groupId, groupPatch);
    this.stampManagedFrameMarker(canvas, path, frame);
    this.captureFrameRelativeGeometry(canvas, path, frame.groupId);

    if (propagate) {
      this.reflowParentChain(canvas, path, frame.groupId);
    }

    if (save) canvas.requestSave(false);
    this.decorate(canvas, path);
    return true;
  }

  allCanvasContexts() {
    const result = [];

    if (typeof this.app.workspace.getLeavesOfType !== "function") {
      const active = this.canvasContext();
      return active ? [active] : [];
    }

    const leaves = this.app.workspace.getLeavesOfType("canvas") || [];

    for (const leaf of leaves) {
      const view = leaf && leaf.view;
      if (
        !view ||
        typeof view.getViewType !== "function" ||
        view.getViewType() !== "canvas" ||
        !view.canvas ||
        !view.file ||
        !view.file.path
      ) {
        continue;
      }

      result.push({
        view,
        canvas: view.canvas,
        path: view.file.path,
        leaf
      });
    }

    return result;
  }

  canvasBindingKey(canvas, path) {
    const id =
      canvas &&
      (
        canvas.id ||
        canvas.canvasId ||
        canvas.instanceId
      );

    return `${path}::${id || "canvas"}::${String(canvas)}`;
  }

  queuePrepareAllCanvases() {
    const delays = [0, 80, 220, 500, 1000];

    for (const delay of delays) {
      const timer = window.setTimeout(() => {
        this.canvasPrepareTimers.delete(timer);
        this.prepareAllCanvases();
      }, delay);

      this.canvasPrepareTimers.add(timer);
    }

    // Preserve the old active-canvas retry path as an extra compatibility layer.
    this.queuePrepareActiveCanvas();
  }

  prepareAllCanvases() {
    const contexts = this.allCanvasContexts();
    const liveKeys = new Set();

    for (const context of contexts) {
      const { canvas, path } = context;
      const host = canvas.canvasEl || canvas.wrapperEl;
      if (!host || !host.isConnected) continue;

      const key = this.canvasBindingKey(canvas, path);
      liveKeys.add(key);

      this.prepareCanvasContext(context);
    }

    // Cleanup closed/replaced Canvas bindings.
    for (const [key, binding] of [...this.canvasBindings.entries()]) {
      if (liveKeys.has(key)) continue;

      if (binding && binding.popupObserver) {
        try { binding.popupObserver.disconnect(); } catch (_) {}
      }

      this.canvasBindings.delete(key);
    }

    return contexts.length;
  }

  ensureAllCanvasBindings() {
    const contexts = this.allCanvasContexts();
    const liveKeys = new Set();

    for (const context of contexts) {
      const { canvas, path } = context;
      const host = canvas.canvasEl || canvas.wrapperEl;
      if (!host || !host.isConnected) continue;

      const key = this.canvasBindingKey(canvas, path);
      liveKeys.add(key);

      const binding = this.canvasBindings.get(key);

      const activeContext = this.canvasContext();
      const isActive =
        !!activeContext &&
        activeContext.canvas === canvas &&
        activeContext.path === path;

      const refreshAge = isActive ? 5000 : 12000;

      const needsPrepare =
        !binding ||
        binding.canvas !== canvas ||
        binding.path !== path ||
        binding.host !== host ||
        !binding.prepared ||
        binding.lastPrepareAt < Date.now() - refreshAge;

      if (needsPrepare) {
        this.prepareCanvasContext(context);
      }
    }

    for (const [key, binding] of [...this.canvasBindings.entries()]) {
      if (!liveKeys.has(key)) {
        if (binding && binding.popupObserver) {
          try { binding.popupObserver.disconnect(); } catch (_) {}
        }
        this.canvasBindings.delete(key);
      }
    }

    // Keep active-canvas legacy heartbeat as well, because pointer/menu code still
    // uses a single active binding for interaction.
    this.ensureActiveCanvasBinding();
  }

  prepareCanvasContext(context) {
    if (!context) return false;

    const { canvas, path } = context;
    const host = canvas.canvasEl || canvas.wrapperEl;
    if (!host || !host.isConnected) return false;

    const key = this.canvasBindingKey(canvas, path);
    let binding = this.canvasBindings.get(key);

    if (!binding) {
      binding = {
        canvas,
        path,
        host,
        prepared: false,
        stateApplied: false,
        repairAttempted: false,
        popupObserver: null,
        lastPrepareAt: 0
      };
      this.canvasBindings.set(key, binding);
    }

    binding.canvas = canvas;
    binding.path = path;
    binding.host = host;
    binding.lastPrepareAt = Date.now();

    // Ensure state bucket migration/backfill runs before decoration.
    this.canvasState(path, true);

    this.lifecycleStep(
      `reattach managed Frame runtime: ${path}`,
      () => this.ensureManagedFrameRuntime(
        canvas,
        path
      )
    );

    if (!binding.repairAttempted) {
      // Canvas views can exist before their live node map is fully hydrated.
      // Never run destructive repair automatically during startup: doing so can
      // mistake a valid managed Group for a deleted node and erase its identity.
      binding.repairAttempted = true;
      this.canvasState(path, true);
    }

    this.lifecycleStep(
      `decorate canvas: ${path}`,
      () => this.decorate(canvas, path)
    );

    this.lifecycleStep(
      `capture relative geometry: ${path}`,
      () => this.refreshAllFrameRelativeGeometry(canvas, path)
    );

    // Re-apply active Note Version file/size and active Frame Version layout.
    // This makes disable/enable and app restart deterministic instead of relying
    // on whatever Canvas serialized state happened to be visible first.
    if (!binding.stateApplied) {
      const applied = this.lifecycleStep(
        `apply persisted version state: ${path}`,
        () => this.reapplyPersistedCanvasState(canvas, path)
      );

      if (applied === true) {
        binding.stateApplied = true;
      }
    }

    // Card menu buttons may be rebuilt even on inactive Canvas leaves.
    this.lifecycleStep(
      `inject card menu buttons: ${path}`,
      () => this.injectCardMenuButtons(canvas, path)
    );

    binding.prepared = true;
    return true;
  }

  canvasHydrationReady(canvas, path) {
    if (
      !canvas ||
      !canvas.nodes ||
      typeof canvas.getData !== "function"
    ) {
      return false;
    }

    let data = null;
    try {
      data = canvas.getData();
    } catch (_) {
      return false;
    }

    if (!data || !Array.isArray(data.nodes)) {
      return false;
    }

    const serializedIds = new Set(
      data.nodes
        .filter((node) => node && typeof node.id === "string")
        .map((node) => node.id)
    );

    if (serializedIds.size && canvas.nodes.size === 0) {
      return false;
    }

    const state = this.canvasState(path, false);
    if (!state) return true;

    const required = new Set();

    for (const [groupId, frame] of Object.entries(state.frames || {})) {
      if (serializedIds.has(groupId)) {
        required.add(groupId);
      }

      for (const childId of frame.children || []) {
        if (serializedIds.has(childId)) {
          required.add(childId);
        }
      }
    }

    for (const nodeId of Object.keys(state.cardVersions || {})) {
      if (serializedIds.has(nodeId)) required.add(nodeId);
    }

    for (const nodeId of Object.keys(state.noteVersions || {})) {
      if (serializedIds.has(nodeId)) required.add(nodeId);
    }

    for (const nodeId of required) {
      if (!canvas.nodes.has(nodeId)) {
        return false;
      }
    }

    return true;
  }

  reapplyPersistedCanvasState(canvas, path) {
    if (!this.canvasHydrationReady(canvas, path)) {
      return false;
    }

    const state = this.canvasState(path, false);
    if (!state || !canvas.nodes) return true;

    // Notes first: restore which Markdown file and size each versioned Note card
    // is supposed to display.
    for (const [nodeId, noteState] of Object.entries(state.noteVersions || {})) {
      if (!noteState || !noteState.versions || !noteState.versions.length) continue;
      const node = canvas.nodes.get(nodeId);
      if (!node) continue;

      noteState.active = Math.max(
        0,
        Math.min(noteState.active || 0, noteState.versions.length - 1)
      );

      const version = noteState.versions[noteState.active];
      if (!version) continue;

      const patch = {};
      if (version.file) patch.file = version.file;
      if (Number.isFinite(version.width)) patch.width = version.width;
      if (Number.isFinite(version.height)) patch.height = version.height;

      this.patchLiveNode(canvas, nodeId, patch);
    }

    // Text cards: restore active text/geometry.
    for (const [nodeId, cardState] of Object.entries(state.cardVersions || {})) {
      if (!cardState || !cardState.versions || !cardState.versions.length) continue;
      const node = canvas.nodes.get(nodeId);
      if (!node) continue;

      cardState.active = Math.max(
        0,
        Math.min(cardState.active || 0, cardState.versions.length - 1)
      );

      const version = cardState.versions[cardState.active];
      if (!version) continue;

      const patch = {
        text: typeof version.text === "string" ? version.text : ""
      };
      if (Number.isFinite(version.width)) patch.width = version.width;
      if (Number.isFinite(version.height)) patch.height = version.height;

      this.patchLiveNode(canvas, nodeId, patch);
    }

    // Frame Versions after cards, so parent geometry can be recomputed from the
    // restored child sizes.
    const frameIds = Object.keys(state.frames || {});

    // Apply deepest frames first to reduce parent churn.
    frameIds.sort((a, b) => {
      const depth = (id) => {
        let d = 0;
        let current = id;
        const seen = new Set();

        while (!seen.has(current)) {
          seen.add(current);
          const parents = this.parentFrames(path, current);
          if (!parents.length) break;
          current = parents[0].groupId;
          d += 1;
        }

        return d;
      };

      return depth(b) - depth(a);
    });

    for (const groupId of frameIds) {
      const versionState =
        state.frameVersions &&
        state.frameVersions[groupId];

      if (versionState && versionState.versions && versionState.versions.length) {
        versionState.active = Math.max(
          0,
          Math.min(
            versionState.active || 0,
            versionState.versions.length - 1
          )
        );

        const frame = state.frames[groupId];
        const version = versionState.versions[versionState.active];

        if (frame && version) {
          frame.children = [...(version.children || [])];
          frame.direction = version.direction || "vertical";
          frame.gap = Number.isFinite(version.gap) ? version.gap : DEFAULT_GAP;
          frame.padding = Number.isFinite(version.padding) ? version.padding : DEFAULT_PADDING;
          frame.nestedSpacing = Number.isFinite(version.nestedSpacing) ? version.nestedSpacing : 16;
          frame.nestedInset = Number.isFinite(version.nestedInset) ? version.nestedInset : 20;
          frame.layoutPaused = !!version.layoutPaused;
        }
      }
    }

    this.updateFrameVersionVisibility(canvas, path);

    if (this.settings.followFrameVersionName) {
      for (const groupId of frameIds) {
        this.updateFrameLabelFromActiveVersion(
          canvas,
          path,
          groupId
        );
      }
    }

    for (const groupId of frameIds) {
      const frame = state.frames[groupId];
      if (!frame) continue;

      this.reflowFrame(
        canvas,
        path,
        frame,
        false,
        false,
        true
      );
    }

    // Parent-chain pass after all direct frame reflows.
    for (const groupId of frameIds) {
      this.reflowParentChain(canvas, path, groupId);
    }

    this.refreshAllFrameRelativeGeometry(canvas, path);
    this.ensureManagedFrameRuntime(canvas, path);
    canvas.requestSave(false);
    this.decorate(canvas, path);
    return true;
  }

  queuePrepareActiveCanvas() {
    // Canvas replacement after a file switch is asynchronous in some Obsidian
    // builds. Retry a few times instead of betting everything on one event tick.
    const delays = [0, 60, 180, 450, 900];

    for (const delay of delays) {
      const timer = window.setTimeout(() => {
        this.prepareTimers.delete(timer);
        this.prepareActiveCanvas();
      }, delay);

      this.prepareTimers.add(timer);
    }
  }

  cleanupDisconnectedToolbarEls() {
    for (const el of [...this.injectedToolbarEls]) {
      if (!el || !el.isConnected) {
        this.injectedToolbarEls.delete(el);
      }
    }
  }

  lifecycleStep(name, fn) {
    try {
      return fn();
    } catch (error) {
      console.error(`[Story Canvas Layout] ${name} failed`, error);
      return null;
    }
  }

  ensureActiveCanvasBinding() {
    const context = this.canvasContext();
    if (!context) return;

    const { canvas, path } = context;
    const host = canvas.canvasEl || canvas.wrapperEl;
    if (!host || !host.isConnected) return;

    const identityChanged =
      this.boundCanvas !== canvas ||
      this.boundCanvasPath !== path ||
      this.boundCanvasHost !== host;

    const pointerBroken =
      this.pointerHost !== host ||
      !this.pointerHost ||
      !this.pointerHost.isConnected;

    const popupBroken =
      this.popupHost !== host ||
      !this.popupObserver;

    const geometryBroken =
      this.geometryCanvas !== canvas ||
      this.geometryPath !== path ||
      !this.geometryTimer;

    const cardMenu = canvas.cardMenuEl;
    const cardMenuMissingTools =
      !!cardMenu &&
      !cardMenu.querySelector(".story-layout-card-menu-tools");

    if (
      identityChanged ||
      pointerBroken ||
      popupBroken ||
      geometryBroken ||
      cardMenuMissingTools
    ) {
      this.prepareActiveCanvas();
    }
  }

  prepareActiveCanvas() {
    const context = this.canvasContext();
    if (!context) return false;

    // First ensure this Canvas gets the generic persisted-state preparation used
    // by inactive leaves too.
    this.prepareCanvasContext(context);

    const { canvas, path } = context;
    const host = canvas.canvasEl || canvas.wrapperEl;

    if (!host || !host.isConnected) {
      return false;
    }

    const identityChanged =
      this.boundCanvas !== canvas ||
      this.boundCanvasPath !== path ||
      this.boundCanvasHost !== host;

    if (identityChanged) {
      this.detachPointerListeners();

      if (this.geometryTimer) {
        window.clearInterval(this.geometryTimer);
      }
      this.geometryTimer = null;
      this.geometryCanvas = null;
      this.geometryPath = null;
      this.nodeGeometry.clear();
      this.frameRelativeGeometry.clear();
      this.frameVersionHiddenNodes.delete(path);
      this.geometryIgnoreUntil.delete(path);
      this.canvasNodeIdSnapshots.delete(path);

      this.detachPopupObserver();
      this.clearIndicator();

      this.boundCanvas = canvas;
      this.boundCanvasPath = path;
      this.boundCanvasHost = host;

      // Do NOT run destructive Repair on Canvas activation.
      // At this point Obsidian may have created the Canvas view/DOM while the
      // live node map is still hydrating. Manual Repair is the only destructive
      // cleanup path.
    }

    this.cleanupDisconnectedToolbarEls();

    if (identityChanged || this.pointerHost !== host) {
      this.lifecycleStep(
        "attach pointer listeners",
        () => this.attachPointerListeners(canvas, path)
      );
    }

    this.lifecycleStep(
      "inject card menu buttons",
      () => this.injectCardMenuButtons(canvas, path)
    );

    this.lifecycleStep(
      "decorate canvas",
      () => this.decorate(canvas, path)
    );

    this.lifecycleStep(
      "capture frame relative geometry",
      () => this.refreshAllFrameRelativeGeometry(canvas, path)
    );

    if (
      this.canvasHydrationReady(canvas, path) &&
      typeof canvas.getData === "function"
    ) {
      try {
        const data = canvas.getData();
        if (data && Array.isArray(data.nodes)) {
          this.canvasNodeIdSnapshots.set(
            path,
            new Set(
              data.nodes
                .filter(
                  (node) =>
                    node &&
                    typeof node.id === "string"
                )
                .map((node) => node.id)
            )
          );
        }
      } catch (_) {}
    }

    if (
      identityChanged ||
      this.geometryCanvas !== canvas ||
      this.geometryPath !== path ||
      !this.geometryTimer
    ) {
      this.lifecycleStep(
        "start geometry watcher",
        () => this.startGeometryWatcher(canvas, path)
      );
    }

    if (
      identityChanged ||
      this.popupHost !== host ||
      !this.popupObserver
    ) {
      this.lifecycleStep(
        "attach popup observer",
        () => this.attachPopupObserver(canvas, path)
      );
    }

    this.lifecycleStep(
      "inject popup toolbar",
      () => this.injectPopupToolbar(canvas, path)
    );

    return true;
  }

  applySizeMode(canvas, frame) {
    let changed = false;

    if (frame.sizeMode === "fixed") {
      frame.fixedSizes = frame.fixedSizes || {};

      for (const id of frame.children) {
        const child = this.liveNodeData(canvas, id);
        if (!child) continue;

        let fixed = frame.fixedSizes[id];
        if (!fixed) {
          fixed = frame.fixedSizes[id] = {
            width: child.width,
            height: child.height
          };
        }

        if (
          Math.abs(child.width - fixed.width) > 0.5 ||
          Math.abs(child.height - fixed.height) > 0.5
        ) {
          this.patchLiveNode(canvas, id, {
            width: fixed.width,
            height: fixed.height
          });
          changed = true;
        }
      }
    }

    return changed;
  }

  detachPopupObserver() {
    if (this.popupObserver) {
      this.popupObserver.disconnect();
    }
    this.popupObserver = null;
    this.popupHost = null;

    if (this.popupRefreshRaf) {
      window.cancelAnimationFrame(this.popupRefreshRaf);
      this.popupRefreshRaf = null;
    }
  }

  isCanvasReadOnly(canvas) {
    if (!canvas) return false;

    const candidates = [
      canvas.readonly,
      canvas.readOnly,
      canvas.isReadonly,
      canvas.isReadOnly,
      canvas.view && canvas.view.readonly,
      canvas.view && canvas.view.readOnly
    ];

    return candidates.some((value) => value === true);
  }

  isCanvasUiInteractionTarget(target) {
    if (!(target instanceof Element)) return false;

    return !!target.closest([
      "button",
      "input",
      "textarea",
      "select",
      "option",
      "a",
      "[contenteditable='true']",
      ".canvas-menu",
      ".canvas-card-menu",
      ".canvas-controls",
      ".canvas-control-group",
      ".canvas-control-item",
      ".menu",
      ".menu-item",
      ".popover",
      ".modal",
      ".tooltip",
      ".canvas-node-resizer",
      ".canvas-node-connection-point",
      ".canvas-node-control",
      ".canvas-edge-label",
      ".story-layout-popup-tools",
      ".story-layout-card-menu-tools"
    ].join(","));
  }

  mutationOnlyTouchesStoryUi(mutations) {
    if (!mutations || !mutations.length) return false;

    return mutations.every((mutation) => {
      const target =
        mutation.target instanceof Element
          ? mutation.target
          : mutation.target && mutation.target.parentElement;

      if (
        target &&
        target.closest &&
        target.closest(
          ".story-layout-popup-tools, .story-layout-card-menu-tools"
        )
      ) {
        return true;
      }

      const added = [...(mutation.addedNodes || [])];
      const removed = [...(mutation.removedNodes || [])];
      const nodes = [...added, ...removed].filter(
        (node) => node instanceof Element
      );

      return (
        nodes.length > 0 &&
        nodes.every((node) =>
          node.matches(
            ".story-layout-popup-tools, .story-layout-card-menu-tools"
          ) ||
          !!node.closest(
            ".story-layout-popup-tools, .story-layout-card-menu-tools"
          )
        )
      );
    });
  }

  attachPopupObserver(canvas, path) {
    this.detachPopupObserver();

    const host = canvas.canvasEl || canvas.wrapperEl;
    if (!host) return;

    this.popupHost = host;
    this.popupObserver = new MutationObserver((mutations) => {
      if (
        this.boundCanvas !== canvas ||
        this.boundCanvasPath !== path ||
        this.popupHost !== host
      ) {
        return;
      }

      // Avoid observer feedback loops when our own toolbar is added/removed.
      if (this.mutationOnlyTouchesStoryUi(mutations)) {
        return;
      }

      // Advanced Canvas can rebuild/extend Popup Menu DOM several times during
      // one selection change. Coalesce all mutations into one refresh.
      if (this.popupRefreshRaf) {
        return;
      }

      this.popupRefreshRaf = window.requestAnimationFrame(() => {
        this.popupRefreshRaf = null;

        this.lifecycleStep(
          "refresh popup toolbar",
          () => this.injectPopupToolbar(canvas, path)
        );
      });
    });

    this.popupObserver.observe(host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"]
    });
  }

  getPopupMenuEl(canvas) {
    // Prefer the Canvas private menu object when available.
    const direct =
      (canvas.menu && (canvas.menu.menuEl || canvas.menu.containerEl || canvas.menu.el)) ||
      null;

    if (direct instanceof HTMLElement && direct.isConnected) {
      return direct;
    }

    const host = canvas.canvasEl || canvas.wrapperEl;
    if (!host) return null;

    // Fallback for Obsidian builds where the private menu object shape differs.
    const candidates = [...host.querySelectorAll(".canvas-menu")].filter((el) => {
      if (!(el instanceof HTMLElement)) return false;

      if (
        canvas.cardMenuEl &&
        (el === canvas.cardMenuEl || canvas.cardMenuEl.contains(el))
      ) {
        return false;
      }

      if (
        el.closest(".canvas-controls, .canvas-control-group") ||
        el.matches(".canvas-card-menu")
      ) {
        return false;
      }

      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    });

    // Popup menu is normally the compact visible menu nearest the current selection.
    return candidates.length ? candidates[candidates.length - 1] : null;
  }

  injectPopupToolbar(canvas, path) {
    const popup = this.getPopupMenuEl(canvas);
    if (!popup) return;

    const frame = this.selectedManagedFrame(canvas, path);
    const selectedNode = this.selectedSingleNode(canvas);
    const selectedData =
      selectedNode && typeof selectedNode.getData === "function"
        ? selectedNode.getData()
        : null;
    const textNodeId =
      selectedData && selectedData.type === "text" ? selectedData.id : null;
    const fileNodeId =
      selectedData && selectedData.type === "file" ? selectedData.id : null;
    const versionState =
      textNodeId ? this.getCardVersionState(path, textNodeId, false) : null;
    const noteVersionState =
      fileNodeId ? this.getNoteVersionState(path, fileNodeId, false) : null;
    const frameVersionState =
      frame ? this.getFrameVersionState(path, frame.groupId, false) : null;

    const existing = popup.querySelector(".story-layout-popup-tools");

    if (!frame && !textNodeId && !fileNodeId) {
      if (existing) existing.remove();
      return;
    }

    const boundKey = frame
      ? `frame:${frame.groupId}:${frameVersionState ? frameVersionState.active : -1}:${frameVersionState ? frameVersionState.versions.length : 0}`
      : textNodeId
        ? `card:${textNodeId}:${versionState ? versionState.active : -1}:${versionState ? versionState.versions.length : 0}`
        : `note:${fileNodeId}:${noteVersionState ? noteVersionState.active : -1}:${noteVersionState ? noteVersionState.versions.length : 0}`;

    if (existing) {
      const currentKey = existing.getAttribute("data-bound-key");
      if (currentKey === boundKey) return;
      existing.remove();
    }

    const wrapper = document.createElement("div");
    wrapper.className = "story-layout-popup-tools";
    wrapper.dataset.storyLayoutOwner = "story-canvas-layout";
    wrapper.setAttribute("data-bound-key", boundKey);

    const makeButton = (icon, title, action) => {
      const button = document.createElement("button");
      button.className = "clickable-icon story-layout-popup-button";
      button.type = "button";
      button.setAttribute("aria-label", title);
      setIcon(button, icon);

      button.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      });

      button.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        action();
        window.setTimeout(() => this.injectPopupToolbar(canvas, path), 0);
      });

      wrapper.appendChild(button);
      return button;
    };

    if (!frame && textNodeId) {
      if (versionState && versionState.versions.length > 1) {
        makeButton("chevron-left", "Previous version", () => {
          void this.switchCardVersion(canvas, path, textNodeId, -1);
        });

        const counter = document.createElement("span");
        counter.className = "story-version-counter";
        counter.textContent = `${versionState.active + 1}/${versionState.versions.length}`;
        const activeVersion = versionState.versions[versionState.active];
        counter.setAttribute(
          "title",
          activeVersion && activeVersion.label
            ? activeVersion.label
            : "Current card version"
        );
        wrapper.appendChild(counter);

        makeButton("chevron-right", "Next version", () => {
          void this.switchCardVersion(canvas, path, textNodeId, 1);
        });
      }

      if (versionState) {
        makeButton("list", "Open version overview", () => {
          this.openCardVersionOverview(canvas, path, textNodeId);
        });

        makeButton("tag", "Name current version", () => {
          this.openRenameVersionModal(canvas, path, textNodeId);
        });
      }

      makeButton("copy-plus", "Duplicate as new version", () => {
        void this.duplicateCardVersion(canvas, path, textNodeId);
      });

      makeButton("file-plus", "New blank version", () => {
        void this.newBlankCardVersion(canvas, path, textNodeId);
      });

      if (versionState && versionState.versions.length > 1) {
        makeButton("trash-2", "Delete current version", () => {
          void this.deleteCurrentCardVersion(canvas, path, textNodeId);
        });
      }

      popup.appendChild(wrapper);
      this.injectedToolbarEls.add(wrapper);
      return;
    }

    if (!frame && fileNodeId) {
      if (noteVersionState && noteVersionState.versions.length > 1) {
        makeButton("chevron-left", "Previous note version", () => {
          void this.switchNoteVersion(canvas, path, fileNodeId, -1);
        });

        const counter = document.createElement("span");
        counter.className = "story-version-counter";
        counter.textContent = `${noteVersionState.active + 1}/${noteVersionState.versions.length}`;
        const active = noteVersionState.versions[noteVersionState.active];
        counter.setAttribute(
          "title",
          active && active.label ? active.label : "Current note version"
        );
        wrapper.appendChild(counter);

        makeButton("chevron-right", "Next note version", () => {
          void this.switchNoteVersion(canvas, path, fileNodeId, 1);
        });
      }

      if (noteVersionState) {
        makeButton("list", "Open note version overview", () => {
          this.openNoteVersionOverview(canvas, path, fileNodeId);
        });

        makeButton("tag", "Name current note version", () => {
          this.openRenameNoteVersionModal(canvas, path, fileNodeId);
        });
      }

      makeButton("file-plus", "Create blank note version", () => {
        this.openCreateBlankNoteVersionModal(canvas, path, fileNodeId);
      });

      makeButton("file-search", "Add existing note as version", () => {
        this.openAddExistingNoteVersionPicker(canvas, path, fileNodeId);
      });

      if (noteVersionState && noteVersionState.versions.length > 1) {
        makeButton("trash-2", "Delete current note version", () => {
          void this.deleteCurrentNoteVersion(canvas, path, fileNodeId);
        });
      }

      popup.appendChild(wrapper);
      this.injectedToolbarEls.add(wrapper);
      return;
    }

    const toolbar = this.settings.toolbar;

    if (frameVersionState) {
      if (
        toolbar.versionNavigation &&
        frameVersionState.versions.length > 1
      ) {
        makeButton("chevron-left", "Previous frame version", () => {
          void this.switchFrameVersion(canvas, path, frame.groupId, -1);
        });
      }

      if (toolbar.versionNavigation) {
        const frameCounter = document.createElement("span");
        frameCounter.className =
          "story-version-counter story-frame-version-counter";
        frameCounter.textContent =
          `${frameVersionState.active + 1}/${frameVersionState.versions.length}`;

        const activeFrameVersion =
          frameVersionState.versions[frameVersionState.active];

        frameCounter.setAttribute(
          "title",
          activeFrameVersion && activeFrameVersion.label
            ? activeFrameVersion.label
            : "Current frame version"
        );

        wrapper.appendChild(frameCounter);
      }

      if (
        toolbar.versionNavigation &&
        frameVersionState.versions.length > 1
      ) {
        makeButton("chevron-right", "Next frame version", () => {
          void this.switchFrameVersion(canvas, path, frame.groupId, 1);
        });
      }

      if (toolbar.versionOverview) {
        makeButton("list", "Open frame version overview", () => {
          this.openFrameVersionOverview(canvas, path, frame.groupId);
        });
      }

      if (toolbar.versionMetadata) {
        makeButton("tag", "Branch name & description", () => {
          this.openRenameFrameVersionModal(canvas, path, frame.groupId);
        });
      }
    }

    if (toolbar.duplicateVersion) {
      makeButton("copy-plus", "Duplicate current frame version", () => {
        void this.duplicateFrameVersion(canvas, path, frame.groupId);
      });
    }

    if (toolbar.blankVersion) {
      makeButton("file-plus", "New blank frame version", () => {
        void this.newBlankFrameVersion(canvas, path, frame.groupId);
      });
    }

    if (
      toolbar.deleteVersion &&
      frameVersionState &&
      frameVersionState.versions.length > 1
    ) {
      makeButton("trash-2", "Delete current frame branch", () => {
        void this.deleteCurrentFrameVersion(
          canvas,
          path,
          frame.groupId
        );
      });
    }

    if (toolbar.pause) {
      makeButton(
        frame.layoutPaused ? "play" : "pause",
        frame.layoutPaused ? "Resume layout" : "Pause layout",
        () => {
          frame.layoutPaused = !frame.layoutPaused;
          if (frame.layoutPaused) {
            void this.persistState();
            this.decorate(canvas, path);
          } else {
            void this.persistAndReflow(canvas, path, frame);
          }
        }
      );
    }

    if (toolbar.direction) {
      makeButton(
        frame.direction === "vertical" ? "columns-3" : "rows-3",
        frame.direction === "vertical"
          ? "Switch to horizontal layout"
          : "Switch to vertical layout",
        () => {
          frame.direction =
            frame.direction === "vertical"
              ? "horizontal"
              : "vertical";
          void this.persistAndReflow(canvas, path, frame);
        }
      );
    }

    const step = 8;

    if (toolbar.gap) {
      makeButton("minus", `Gap - (${frame.gap}px)`, () => {
        frame.gap = Math.max(
          0,
          (Number(frame.gap) || this.defaultGap()) - step
        );
        void this.persistAndReflow(canvas, path, frame);
      });

      makeButton("plus", `Gap + (${frame.gap}px)`, () => {
        frame.gap = Math.min(
          240,
          (Number(frame.gap) || this.defaultGap()) + step
        );
        void this.persistAndReflow(canvas, path, frame);
      });
    }

    if (toolbar.padding) {
      makeButton("shrink", `Padding - (${frame.padding}px)`, () => {
        frame.padding = Math.max(
          0,
          (Number(frame.padding) || this.defaultPadding()) - step
        );
        void this.persistAndReflow(canvas, path, frame);
      });

      makeButton("expand", `Padding + (${frame.padding}px)`, () => {
        frame.padding = Math.min(
          240,
          (Number(frame.padding) || this.defaultPadding()) + step
        );
        void this.persistAndReflow(canvas, path, frame);
      });
    }

    if (toolbar.nestedSpacing) {
      makeButton(
        "minus",
        `Nested spacing - (${frame.nestedSpacing}px)`,
        () => {
          frame.nestedSpacing = Math.max(
            0,
            (Number(frame.nestedSpacing) || 0) - step
          );
          void this.persistAndReflow(canvas, path, frame);
        }
      );

      makeButton(
        "plus",
        `Nested spacing + (${frame.nestedSpacing}px)`,
        () => {
          frame.nestedSpacing = Math.min(
            240,
            (Number(frame.nestedSpacing) || 0) + step
          );
          void this.persistAndReflow(canvas, path, frame);
        }
      );
    }

    if (toolbar.nestedInset) {
      makeButton(
        "arrow-left",
        `Nested inset - (${frame.nestedInset}px)`,
        () => {
          frame.nestedInset = Math.max(
            0,
            (Number(frame.nestedInset) || 0) - step
          );
          void this.persistAndReflow(canvas, path, frame);
        }
      );

      makeButton(
        "arrow-right",
        `Nested inset + (${frame.nestedInset}px)`,
        () => {
          frame.nestedInset = Math.min(
            240,
            (Number(frame.nestedInset) || 0) + step
          );
          void this.persistAndReflow(canvas, path, frame);
        }
      );
    }



    popup.appendChild(wrapper);
    this.injectedToolbarEls.add(wrapper);
  }

  cleanupDeletedCanvasNodeReferences(path, nodeId) {
    const state = this.canvasState(path, false);
    const affectedFrames = new Set();
    if (!state) return affectedFrames;

    for (const frame of Object.values(state.frames || {})) {
      if ((frame.children || []).includes(nodeId)) {
        frame.children =
          frame.children.filter((id) => id !== nodeId);
        affectedFrames.add(frame.groupId);
      }

      if (frame.fixedSizes) {
        delete frame.fixedSizes[nodeId];
      }
    }

    for (const [groupId, versionState] of Object.entries(
      state.frameVersions || {}
    )) {
      (versionState.versions || []).forEach((version, index) => {
        if ((version.children || []).includes(nodeId)) {
          version.children =
            version.children.filter((id) => id !== nodeId);

          if (index === versionState.active) {
            affectedFrames.add(groupId);
          }
        }

        if (version.crossAxisRatios) {
          delete version.crossAxisRatios[nodeId];
        }
      });

      versionState.visibleDetached =
        (versionState.visibleDetached || [])
          .filter((id) => id !== nodeId);
    }

    if (state.cardVersions) {
      delete state.cardVersions[nodeId];
    }
    if (state.noteVersions) {
      delete state.noteVersions[nodeId];
    }

    if (state.frames && state.frames[nodeId]) {
      delete state.frames[nodeId];
    }
    if (
      state.frameVersions &&
      state.frameVersions[nodeId]
    ) {
      delete state.frameVersions[nodeId];
    }

    return affectedFrames;
  }

  serializedCanvasNodeIds(canvas) {
    if (
      !canvas ||
      typeof canvas.getData !== "function"
    ) {
      return null;
    }

    let data = null;
    try {
      data = canvas.getData();
    } catch (_) {
      return null;
    }

    if (!data || !Array.isArray(data.nodes)) {
      return null;
    }

    return new Set(
      data.nodes
        .filter(
          (node) =>
            node &&
            typeof node.id === "string"
        )
        .map((node) => node.id)
    );
  }

  reconcileManagedFrameChildren(canvas, path) {
    if (!this.canvasHydrationReady(canvas, path)) {
      return new Set();
    }

    const state = this.canvasState(path, false);
    const serializedIds =
      this.serializedCanvasNodeIds(canvas);

    const affectedFrames = new Set();

    if (
      !state ||
      !state.frames ||
      !serializedIds
    ) {
      return affectedFrames;
    }

    const deletedIds = new Set();

    // The authoritative active membership is frame.children. If a referenced
    // child is no longer in serialized Canvas JSON, it was truly deleted.
    for (const frame of Object.values(state.frames)) {
      for (const childId of frame.children || []) {
        if (!serializedIds.has(childId)) {
          deletedIds.add(childId);
        }
      }
    }

    if (!deletedIds.size) {
      return affectedFrames;
    }

    for (const nodeId of deletedIds) {
      for (
        const groupId of
        this.cleanupDeletedCanvasNodeReferences(
          path,
          nodeId
        )
      ) {
        affectedFrames.add(groupId);
      }

      this.nodeGeometry.delete(
        `${path}::${nodeId}`
      );
      this.frameRelativeGeometry.delete(
        `${path}::${nodeId}`
      );
    }

    return affectedFrames;
  }

  detectAndHandleCanvasNodeDeletion(canvas, path) {
    if (
      !this.canvasHydrationReady(canvas, path) ||
      typeof canvas.getData !== "function"
    ) {
      return new Set();
    }

    let data = null;
    try {
      data = canvas.getData();
    } catch (_) {
      return new Set();
    }

    if (!data || !Array.isArray(data.nodes)) {
      return new Set();
    }

    const current = new Set(
      data.nodes
        .filter(
          (node) =>
            node &&
            typeof node.id === "string"
        )
        .map((node) => node.id)
    );

    const previous =
      this.canvasNodeIdSnapshots.get(path);

    this.canvasNodeIdSnapshots.set(path, current);

    if (!previous) {
      return new Set();
    }

    const removed = [...previous]
      .filter((id) => !current.has(id));

    if (!removed.length) {
      return new Set();
    }

    const affectedFrames = new Set();

    for (const nodeId of removed) {
      for (
        const groupId of
        this.cleanupDeletedCanvasNodeReferences(
          path,
          nodeId
        )
      ) {
        affectedFrames.add(groupId);
      }

      this.nodeGeometry.delete(
        `${path}::${nodeId}`
      );
      this.frameRelativeGeometry.delete(
        `${path}::${nodeId}`
      );
    }

    return affectedFrames;
  }

  startGeometryWatcher(canvas, path) {
    if (this.geometryTimer) window.clearInterval(this.geometryTimer);
    this.geometryTimer = null;
    this.geometryCanvas = canvas;
    this.geometryPath = path;
    this.nodeGeometry.clear();
    this.frameRelativeGeometry.clear();

    const scan = () => {
      if (
        (this.geometryIgnoreUntil.get(path) || 0) > Date.now()
      ) {
        return;
      }

      if (
        this.geometryCanvas !== canvas ||
        this.geometryPath !== path ||
        this.boundCanvas !== canvas ||
        this.boundCanvasPath !== path
      ) {
        return;
      }

      const state = this.canvasState(path, false);
      if (!state || !canvas.nodes) return;
      if (this.dragState) return;

      const touchedFrames =
        this.reconcileManagedFrameChildren(
          canvas,
          path
        );

      for (
        const groupId of
        this.detectAndHandleCanvasNodeDeletion(
          canvas,
          path
        )
      ) {
        touchedFrames.add(groupId);
      }

      if (touchedFrames.size) {
        this.updateFrameVersionVisibility(
          canvas,
          path
        );
      }

      for (const frame of Object.values(state.frames)) {
        const key = `${path}::${frame.groupId}`;
        if (!this.frameRelativeGeometry.has(key)) {
          this.captureFrameRelativeGeometry(canvas, path, frame.groupId);
        }
      }

      // Build parent membership once for this scan.
      const nestedFrameIds = new Set();
      for (const frame of Object.values(state.frames)) {
        for (const childId of frame.children || []) {
          if (state.frames[childId]) {
            nestedFrameIds.add(childId);
          }
        }
      }

      // Seed geometry for top-level managed Frames. Nested managed Frames are
      // measured in their parent's child loop below so native x/y movement can
      // be detected before the snapshot is updated.
      for (const frame of Object.values(state.frames)) {
        if (nestedFrameIds.has(frame.groupId)) continue;

        const groupData = this.liveNodeData(canvas, frame.groupId);
        if (!groupData) continue;

        const groupKey = `${path}::${frame.groupId}`;

        if (!this.nodeGeometry.has(groupKey)) {
          this.nodeGeometry.set(groupKey, {
            x: Number(groupData.x) || 0,
            y: Number(groupData.y) || 0,
            width: Number(groupData.width) || 0,
            height: Number(groupData.height) || 0
          });
        }
      }

      for (const frame of Object.values(state.frames)) {
        if (frame.layoutPaused) continue;

        const sizeModeChanged = this.applySizeMode(canvas, frame);
        if (sizeModeChanged) touchedFrames.add(frame.groupId);

        for (const id of frame.children) {
          const data = this.liveNodeData(canvas, id);
          if (!data) continue;

          const key = `${path}::${id}`;
          const current = {
            x: Number(data.x) || 0,
            y: Number(data.y) || 0,
            width: Number(data.width) || 0,
            height: Number(data.height) || 0
          };

          const previous = this.nodeGeometry.get(key);
          this.nodeGeometry.set(key, current);

          if (previous) {
            const dx = current.x - (Number(previous.x) || 0);
            const dy = current.y - (Number(previous.y) || 0);

            const moved =
              Math.abs(dx) > 0.5 ||
              Math.abs(dy) > 0.5;

            const resized =
              Math.abs(previous.width - current.width) > 0.5 ||
              Math.abs(previous.height - current.height) > 0.5;

            // Native Canvas alignment may already move BOTH the nested
            // managed Frame and its descendants. Never add dx/dy to the
            // descendants' current positions, because that can double-move them.
            //
            // Instead restore the nested Frame's internal layout from the
            // relative geometry captured before the native operation.
            if (moved && this.isManagedFrame(path, id)) {
              const relativeKey = `${path}::${id}`;
              const priorRelative =
                this.frameRelativeGeometry.get(relativeKey);

              if (priorRelative) {
                this.restoreFrameRelativeGeometry(
                  canvas,
                  path,
                  id,
                  priorRelative
                );
              } else {
                this.captureFrameRelativeGeometry(
                  canvas,
                  path,
                  id
                );
              }
            }

            if (resized) {
              touchedFrames.add(frame.groupId);
            }
          }
        }
      }

      for (const groupId of touchedFrames) {
        const frame = state.frames[groupId];
        if (!frame) continue;

        this.reflowFrame(
          canvas,
          path,
          frame,
          false,
          true,
          true
        );

        this.syncActiveFrameVersion(
          path,
          groupId,
          canvas
        );

        this.stampManagedFrameMarker(canvas, path, frame);
      }

      if (touchedFrames.size) {
        this.updateFrameVersionVisibility(
          canvas,
          path
        );
        this.resetGeometryBaselineForPath(
          canvas,
          path
        );
        canvas.requestSave(false);
        void this.persistState();
      }
    };

    scan();
    this.geometryTimer = window.setInterval(scan, 240);
  }

  attachPointerListeners(canvas, path) {
    this.detachPointerListeners();

    const host = canvas.canvasEl || canvas.wrapperEl;
    if (!host) return;
    this.pointerHost = host;

    this.pointerDownHandler = (ev) => {
      if (
        this.boundCanvas !== canvas ||
        this.boundCanvasPath !== path ||
        this.pointerHost !== host
      ) {
        return;
      }

      // Do not steal interaction from native Canvas or Advanced Canvas UI.
      // This includes popup/card/control menus, resize handles, connection
      // points, editable fields, and Story Layout's own toolbar.
      if (
        this.isCanvasReadOnly(canvas) ||
        this.isCanvasUiInteractionTarget(ev.target)
      ) {
        this.dragState = null;
        this.clearIndicator();
        return;
      }

      // Any new node gesture clears stale visual state first.
      this.clearIndicator();
      this.lastPointer = { x: ev.clientX, y: ev.clientY };

      if (ev.button !== 0) {
        this.dragState = null;
        return;
      }

      const id = this.nodeIdFromEventTarget(canvas, ev.target);
      if (!id) {
        this.dragState = null;
        return;
      }

      const data = this.liveNodeData(canvas, id);
      if (!data || (data.type === "group" && !this.isManagedFrame(path, id))) {
        this.dragState = null;
        return;
      }

      this.dragState = {
        nodeId: id,
        sourceFrameId: (this.frameForNodeId(path, id) || {}).groupId || null,
        candidateFrameId: null,
        insertionIndex: null,
        moved: false,
        startX: ev.clientX,
        startY: ev.clientY
      };
    };

    this.pointerMoveHandler = (ev) => {
      if (
        this.boundCanvas !== canvas ||
        this.boundCanvasPath !== path
      ) {
        return;
      }

      if (this.isCanvasReadOnly(canvas)) {
        this.dragState = null;
        this.clearIndicator();
        return;
      }

      this.lastPointer = { x: ev.clientX, y: ev.clientY };
      if (!this.dragState) return;

      const d = Math.hypot(
        ev.clientX - this.dragState.startX,
        ev.clientY - this.dragState.startY
      );

      if (
        d <
        this.pointerMoveThreshold(ev)
      ) {
        return;
      }

      this.dragState.moved = true;

      const hit = this.findInsertionTarget(
        canvas,
        path,
        this.dragState.nodeId,
        ev.clientX,
        ev.clientY
      );

      if (!hit) {
        this.dragState.candidateFrameId = null;
        this.dragState.insertionIndex = null;
        this.clearIndicator();
        return;
      }

      this.dragState.candidateFrameId = hit.frame.groupId;
      this.dragState.insertionIndex = hit.index;
      this.showIndicator(hit, canvas);
    };

    this.pointerUpHandler = (ev) => {
      if (
        this.boundCanvas !== canvas ||
        this.boundCanvasPath !== path
      ) {
        this.dragState = null;
        this.clearIndicator();
        return;
      }

      if (this.isCanvasReadOnly(canvas)) {
        this.dragState = null;
        this.clearIndicator();
        return;
      }

      this.lastPointer = { x: ev.clientX, y: ev.clientY };

      const snapshot = this.dragState;
      this.dragState = null;
      this.clearIndicator();

      if (!snapshot || !snapshot.moved) return;

      // Recompute once from the actual release coordinate. This avoids committing
      // an old candidate if Obsidian stopped sending pointermove during its drag.
      const finalHit = this.findInsertionTarget(
        canvas,
        path,
        snapshot.nodeId,
        ev.clientX,
        ev.clientY
      );

      snapshot.candidateFrameId = finalHit ? finalHit.frame.groupId : null;
      snapshot.insertionIndex = finalHit ? finalHit.index : null;

      window.setTimeout(() => void this.commitPointerDrop(canvas, path, snapshot), 0);
    };

    this.pointerCancelHandler = () => {
      this.dragState = null;
      this.clearIndicator();
    };

    this.windowBlurHandler = () => {
      this.dragState = null;
      this.clearIndicator();
    };

    this.dragOverHandler = (ev) => {
      if (this.isCanvasReadOnly(canvas)) return;

      if (
        ev.dataTransfer &&
        ev.dataTransfer.types.includes(
          "application/x-story-layout-frame"
        )
      ) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
      }
    };

    this.dropHandler = (ev) => {
      if (this.isCanvasReadOnly(canvas)) return;
      if (!ev.dataTransfer) return;
      const direction = ev.dataTransfer.getData("application/x-story-layout-frame");
      if (direction !== "vertical" && direction !== "horizontal") return;

      ev.preventDefault();
      this.dragState = null;
      this.clearIndicator();

      let pos = null;
      if (typeof canvas.posFromEvt === "function") {
        try { pos = canvas.posFromEvt(ev); } catch (_) {}
      }

      if (!pos) {
        new Notice("This Obsidian version did not expose Canvas drop coordinates.");
        return;
      }
      void this.createEmptyFrame(canvas, path, direction, pos.x, pos.y);
    };

    // pointerdown must originate in this canvas, but move/up are intentionally global.
    // Obsidian may capture/reparent the dragged node and the release can happen outside
    // canvasEl; listening only on canvasEl caused 0.2.0/0.2.1 commit failures.
    host.addEventListener("pointerdown", this.pointerDownHandler, true);
    document.addEventListener("pointermove", this.pointerMoveHandler, true);
    document.addEventListener("pointerup", this.pointerUpHandler, true);
    document.addEventListener("pointercancel", this.pointerCancelHandler, true);
    window.addEventListener("blur", this.windowBlurHandler, true);

    host.addEventListener("dragover", this.dragOverHandler, true);
    host.addEventListener("drop", this.dropHandler, true);
  }

  detachPointerListeners() {
    if (this.pointerHost && this.pointerDownHandler) {
      this.pointerHost.removeEventListener("pointerdown", this.pointerDownHandler, true);
    }

    if (this.pointerMoveHandler) {
      document.removeEventListener("pointermove", this.pointerMoveHandler, true);
    }
    if (this.pointerUpHandler) {
      document.removeEventListener("pointerup", this.pointerUpHandler, true);
    }
    if (this.pointerCancelHandler) {
      document.removeEventListener("pointercancel", this.pointerCancelHandler, true);
    }
    if (this.windowBlurHandler) {
      window.removeEventListener("blur", this.windowBlurHandler, true);
    }

    if (this.pointerHost && this.dragOverHandler) {
      this.pointerHost.removeEventListener("dragover", this.dragOverHandler, true);
    }
    if (this.pointerHost && this.dropHandler) {
      this.pointerHost.removeEventListener("drop", this.dropHandler, true);
    }

    this.pointerHost = null;
    this.pointerDownHandler = null;
    this.pointerMoveHandler = null;
    this.pointerUpHandler = null;
    this.pointerCancelHandler = null;
    this.windowBlurHandler = null;
    this.dragOverHandler = null;
    this.dropHandler = null;
    this.dragState = null;
    this.clearIndicator();
  }

  nodeIdFromEventTarget(canvas, target) {
    if (!(target instanceof Element) || !canvas.nodes) return null;
    const nodeEl = target.closest(".canvas-node");
    if (!nodeEl) return null;
    for (const [id, node] of canvas.nodes.entries()) {
      if (node.nodeEl === nodeEl || (node.nodeEl && node.nodeEl.contains(target))) return id;
    }
    return null;
  }

  findInsertionTarget(canvas, path, draggedId, clientX, clientY) {
    const state = this.canvasState(path, false);
    if (!state || !canvas.nodes) return null;

    const candidates = [];

    for (const frame of Object.values(state.frames)) {
      if (frame.layoutPaused) continue;
      if (!this.canInsertNodeIntoFrame(path, draggedId, frame.groupId)) continue;

      const groupNode = canvas.nodes.get(frame.groupId);
      if (!groupNode || !groupNode.nodeEl) continue;

      const rect = groupNode.nodeEl.getBoundingClientRect();
      const tolerance = 12;
      const inside =
        clientX >= rect.left - tolerance &&
        clientX <= rect.right + tolerance &&
        clientY >= rect.top - tolerance &&
        clientY <= rect.bottom + tolerance;

      if (!inside) continue;

      const others = frame.children
        .filter((id) => id !== draggedId)
        .map((id) => canvas.nodes.get(id))
        .filter((n) => n && n.nodeEl);

      const axis = frame.direction === "vertical" ? clientY : clientX;
      const centers = others.map((node) => {
        const r = node.nodeEl.getBoundingClientRect();
        return frame.direction === "vertical"
          ? r.top + r.height / 2
          : r.left + r.width / 2;
      });

      let index = 0;
      while (index < centers.length && axis >= centers[index]) index++;

      // Prefer the smallest frame under the pointer when frames overlap/nest.
      candidates.push({
        frame,
        groupNode,
        others,
        index,
        area: Math.max(1, rect.width * rect.height)
      });
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => a.area - b.area);
    return candidates[0];
  }

  showIndicator(hit, canvas) {
    this.clearIndicator();
    const el = document.body.createDiv({ cls: "story-layout-insertion-indicator" });
    this.indicator = el;

    const frame = hit.frame;
    const groupRect = hit.groupNode.nodeEl.getBoundingClientRect();
    const before = hit.others[hit.index] || null;
    const after = hit.index > 0 ? hit.others[hit.index - 1] : null;

    if (frame.direction === "vertical") {
      let y;
      if (before && after) {
        const rb = before.nodeEl.getBoundingClientRect();
        const ra = after.nodeEl.getBoundingClientRect();
        y = (ra.bottom + rb.top) / 2;
      } else if (before) {
        const r = before.nodeEl.getBoundingClientRect();
        y = (groupRect.top + r.top) / 2;
      } else if (after) {
        const r = after.nodeEl.getBoundingClientRect();
        y = (r.bottom + groupRect.bottom) / 2;
      } else {
        y = groupRect.top + groupRect.height / 2;
      }
      Object.assign(el.style, {
        left: `${groupRect.left + 18}px`,
        top: `${y - 2}px`,
        width: `${Math.max(40, groupRect.width - 36)}px`,
        height: "4px"
      });
    } else {
      let x;
      if (before && after) {
        const rb = before.nodeEl.getBoundingClientRect();
        const ra = after.nodeEl.getBoundingClientRect();
        x = (ra.right + rb.left) / 2;
      } else if (before) {
        const r = before.nodeEl.getBoundingClientRect();
        x = (groupRect.left + r.left) / 2;
      } else if (after) {
        const r = after.nodeEl.getBoundingClientRect();
        x = (r.right + groupRect.right) / 2;
      } else {
        x = groupRect.left + groupRect.width / 2;
      }
      Object.assign(el.style, {
        left: `${x - 2}px`,
        top: `${groupRect.top + 18}px`,
        width: "4px",
        height: `${Math.max(40, groupRect.height - 36)}px`
      });
    }
  }

  clearIndicator() {
    if (this.indicator) this.indicator.remove();
    this.indicator = null;
  }

  async commitPointerDrop(canvas, path, snapshot) {
    const state = this.canvasState(path, false);
    if (!state) return;

    const beforeMembership = [];
    for (const frame of Object.values(state.frames)) {
      if (frame.children.includes(snapshot.nodeId)) {
        beforeMembership.push(frame.groupId);
      }
    }

    const targetFrame =
      snapshot.candidateFrameId ? state.frames[snapshot.candidateFrameId] : null;

    // Capture alignment BEFORE changing membership. Reflow after insertion must
    // preserve existing cross-axis placement instead of snapping all children
    // to the Frame's start edge.
    const preDropCrossAxis = new Map();

    for (const frame of Object.values(state.frames)) {
      preDropCrossAxis.set(
        frame.groupId,
        this.captureFrameCrossAxisRatios(
          canvas,
          path,
          frame
        )
      );
    }

    // Active frames behave normally: moving a child out removes membership.
    // Paused frames intentionally keep membership during free dragging,
    // unless the child is explicitly dropped into another active layout frame.
    for (const frame of Object.values(state.frames)) {
      const contains = frame.children.includes(snapshot.nodeId);
      if (!contains) continue;

      const movingToDifferentActiveFrame =
        !!targetFrame && targetFrame.groupId !== frame.groupId && !targetFrame.layoutPaused;

      if (!frame.layoutPaused || movingToDifferentActiveFrame) {
        frame.children = frame.children.filter((id) => id !== snapshot.nodeId);
        if (frame.fixedSizes && frame.fixedSizes[snapshot.nodeId]) {
          delete frame.fixedSizes[snapshot.nodeId];
        }
      }
    }

    // Then insert into the release target, if any.
    if (snapshot.candidateFrameId) {
      const target = state.frames[snapshot.candidateFrameId];
      if (
        target &&
        !target.layoutPaused &&
        this.canInsertNodeIntoFrame(path, snapshot.nodeId, target.groupId)
      ) {
        const index = Math.max(
          0,
          Math.min(
            snapshot.insertionIndex ?? target.children.length,
            target.children.length
          )
        );
        target.children.splice(index, 0, snapshot.nodeId);

        const targetRatios =
          preDropCrossAxis.get(target.groupId) || {};

        if (
          !Number.isFinite(
            Number(targetRatios[snapshot.nodeId])
          )
        ) {
          targetRatios[snapshot.nodeId] =
            this.inheritedCrossAxisRatio(
              canvas,
              path,
              target,
              snapshot.nodeId,
              index,
              targetRatios
            );
        }

        preDropCrossAxis.set(
          target.groupId,
          targetRatios
        );

        if (target.sizeMode === "fixed") {
          target.fixedSizes = target.fixedSizes || {};
          const child = this.liveNodeData(canvas, snapshot.nodeId);
          if (child) {
            target.fixedSizes[snapshot.nodeId] = {
              width: child.width,
              height: child.height
            };
          }
        }
      }
    }

    const afterMembership =
      snapshot.candidateFrameId &&
      state.frames[snapshot.candidateFrameId] &&
      !state.frames[snapshot.candidateFrameId].layoutPaused
        ? [snapshot.candidateFrameId]
        : beforeMembership.filter((groupId) => {
            const frame = state.frames[groupId];
            return frame && frame.layoutPaused && frame.children.includes(snapshot.nodeId);
          });

    const membershipChanged =
      beforeMembership.join("|") !== afterMembership.join("|");

    // Reordering inside the same frame also matters even when membership is unchanged.
    const sourceOrTarget = new Set([
      ...beforeMembership,
      ...(snapshot.candidateFrameId ? [snapshot.candidateFrameId] : [])
    ]);

    // A node entering any active managed Frame is no longer globally detached.
    // Clear stale detached-visible flags from every Frame Version state.
    if (snapshot.candidateFrameId) {
      for (const versionState of Object.values(state.frameVersions || {})) {
        if (!versionState || !Array.isArray(versionState.visibleDetached)) continue;
        versionState.visibleDetached =
          versionState.visibleDetached.filter((id) => id !== snapshot.nodeId);
      }
    }

    for (const groupId of sourceOrTarget) {
      const versionState = this.getFrameVersionState(path, groupId, false);
      if (!versionState) continue;

      const wasSource = beforeMembership.includes(groupId);
      const isTarget = snapshot.candidateFrameId === groupId;

      if (wasSource && !isTarget && !snapshot.candidateFrameId) {
        if (!versionState.visibleDetached.includes(snapshot.nodeId)) {
          versionState.visibleDetached.push(snapshot.nodeId);
        }
      }

      if (isTarget) {
        versionState.visibleDetached =
          versionState.visibleDetached.filter((id) => id !== snapshot.nodeId);
      }

      // Active version snapshot is synchronized after the final reflow,
      // when geometry is stable.
    }

    await this.persistState();

    const applyAffectedReflow = (finalPass = false) => {
      const reflowed = new Set();

      for (const groupId of sourceOrTarget) {
        const frame = state.frames[groupId];
        if (!frame) continue;

        this.reflowFrame(
          canvas,
          path,
          frame,
          false,
          true,
          true,
          preDropCrossAxis.get(groupId) || {}
        );
        reflowed.add(groupId);
      }

      // Same-frame reorder also needs an explicit pass.
      if (
        !membershipChanged &&
        snapshot.candidateFrameId &&
        !reflowed.has(snapshot.candidateFrameId)
      ) {
        const frame =
          state.frames[snapshot.candidateFrameId];

        if (frame) {
          this.reflowFrame(
            canvas,
            path,
            frame,
            false,
            true,
            true,
            preDropCrossAxis.get(
              snapshot.candidateFrameId
            ) || {}
          );
          reflowed.add(
            snapshot.candidateFrameId
          );
        }
      }

      if (finalPass) {
        for (const groupId of reflowed) {
          const frame = state.frames[groupId];
          if (!frame) continue;

          this.syncActiveFrameVersion(
            path,
            groupId,
            canvas
          );

          this.stampManagedFrameMarker(canvas, path, frame);
        }

        void this.persistState();
      }

      canvas.requestSave(false);
      this.updateFrameVersionVisibility(canvas, path);
      this.resetGeometryBaselineForPath(canvas, path);
      this.decorate(canvas, path);
    };

    // First pass now, second pass after Obsidian finishes its own drag-position
    // commit. The second pass also persists the final geometry.
    applyAffectedReflow(false);
    window.setTimeout(
      () => applyAffectedReflow(true),
      80
    );
  }

  injectCardMenuButtons(canvas, path) {
    const menu = canvas.cardMenuEl;
    if (!menu) return;

    const existing = [
      ...menu.querySelectorAll(".story-layout-card-menu-tools")
    ];

    if (!this.settings.toolbar.createFrameButtons) {
      for (const el of existing) {
        el.remove();
        this.injectedToolbarEls.delete(el);
      }
      return;
    }

    if (existing.length) {
      // Keep one valid instance; remove stale duplicates that can appear when
      // another Canvas plugin rebuilds/reparents the Card Menu.
      for (const duplicate of existing.slice(1)) {
        duplicate.remove();
        this.injectedToolbarEls.delete(duplicate);
      }
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "story-layout-card-menu-tools";
    wrapper.dataset.storyLayoutOwner = "story-canvas-layout";
    wrapper.setAttribute("aria-label", "Story layout frame tools");

    const addButton = (direction) => {
      const button = document.createElement("button");
      button.className = "clickable-icon story-layout-card-menu-button";
      button.type = "button";

      const mobile =
        this.isMobilePlatform();

      // HTML5 drag-and-drop is desktop-oriented and inconsistent in Obsidian
      // Mobile. Mobile uses the existing click behavior: selected nodes are
      // wrapped, otherwise an empty Frame is created at Canvas center.
      button.draggable = !mobile;

      button.setAttribute(
        "aria-label",
        `Add ${direction} layout frame`
      );

      if (!mobile) {
        button.setAttribute(
          "title",
          `Click: create at center. Drag: place ${direction} layout frame.`
        );
      }
      setIcon(button, direction === "vertical" ? "rows-3" : "columns-3");

      button.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        const context = this.canvasContext(canvas);
        if (!context) return;

        const currentPath = context.path;
        const selected = this.selectedNonGroupNodes(canvas);

        if (selected.length) {
          void this.createFrame(canvas, currentPath, direction, selected);
        } else {
          void this.createEmptyFrameAtCenter(canvas, currentPath, direction);
        }
      });

      button.addEventListener("dragstart", (ev) => {
        if (mobile) {
          ev.preventDefault();
          return;
        }

        if (!ev.dataTransfer) return;

        ev.dataTransfer.setData(
          "application/x-story-layout-frame",
          direction
        );
        ev.dataTransfer.effectAllowed = "copy";
      });

      wrapper.appendChild(button);
    };

    addButton("vertical");
    addButton("horizontal");
    menu.appendChild(wrapper);
    this.injectedToolbarEls.add(wrapper);
  }

  decorate(canvas, path) {
    const state = this.canvasState(path, false);
    if (!canvas.nodes) return;

    for (const node of canvas.nodes.values()) {
      if (!node.nodeEl) continue;
      node.nodeEl.classList.remove("story-layout-frame", "story-layout-vertical", "story-layout-horizontal", "story-layout-paused", "story-layout-nested");
    }

    if (!state) return;

    this.updateFrameVersionVisibility(canvas, path);

    if (state.noteVersions) {
      for (const [nodeId, versionState] of Object.entries(state.noteVersions)) {
        const node = canvas.nodes.get(nodeId);
        if (!node || !node.nodeEl || !versionState || !versionState.versions || !versionState.versions.length) continue;

        const data = typeof node.getData === "function" ? node.getData() : null;
        if (!data || data.type !== "file") continue;

        versionState.active = Math.max(
          0,
          Math.min(versionState.active || 0, versionState.versions.length - 1)
        );

        const badge = document.createElement("div");
        badge.className = "story-card-version-badge story-note-version-badge";

        const activeVersion =
          versionState.versions[versionState.active];

        if (
          !activeVersion ||
          !activeVersion.file ||
          !this.app.vault.getAbstractFileByPath(activeVersion.file)
        ) {
          badge.classList.add("is-broken");
        }
        badge.textContent = `${versionState.active + 1}/${versionState.versions.length}`;

        const active = versionState.versions[versionState.active];
        badge.setAttribute(
          "title",
          active && active.label
            ? active.label
            : (
                active &&
                active.file &&
                this.app.vault.getAbstractFileByPath(active.file)
                  ? `Note version ${versionState.active + 1}/${versionState.versions.length}`
                  : `Broken Note version ${versionState.active + 1}/${versionState.versions.length}`
              )
        );
        node.nodeEl.appendChild(badge);
      }
    }

    for (const frame of Object.values(state.frames)) {
      const node = canvas.nodes.get(frame.groupId);
      if (!node || !node.nodeEl) continue;
      node.nodeEl.classList.add("story-layout-frame");
      node.nodeEl.classList.add(frame.direction === "vertical" ? "story-layout-vertical" : "story-layout-horizontal");
      node.nodeEl.classList.toggle("story-layout-paused", !!frame.layoutPaused);
      node.nodeEl.classList.toggle(
        "story-layout-nested",
        this.parentFrames(path, frame.groupId).length > 0
      );

      for (const oldBadge of node.nodeEl.querySelectorAll(".story-frame-version-badge")) {
        oldBadge.remove();
      }

      const frameVersionState = this.getFrameVersionState(path, frame.groupId, false);
      if (frameVersionState && frameVersionState.versions.length) {
        const badge = document.createElement("div");
        badge.className = "story-frame-version-badge";
        badge.textContent = `${frameVersionState.active + 1}/${frameVersionState.versions.length}`;
        const activeFrameVersion =
          frameVersionState.versions[frameVersionState.active];

        badge.setAttribute(
          "title",
          activeFrameVersion && activeFrameVersion.label
            ? activeFrameVersion.label
            : `Frame version ${frameVersionState.active + 1}/${frameVersionState.versions.length}`
        );
        node.nodeEl.appendChild(badge);
      }
    }
  }
};
