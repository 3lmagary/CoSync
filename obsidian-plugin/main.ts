import { Plugin, MarkdownView, TFile, PluginSettingTab, App, Setting } from 'obsidian';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { Compartment, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

interface CoSyncSettings {
  serverUrl: string;
  token: string;
  workspaceId: string;
}

const DEFAULT_SETTINGS: CoSyncSettings = {
  serverUrl: 'http://localhost:4000',
  token: '',
  workspaceId: 'ws-default'
};

export default class CoSyncPlugin extends Plugin {
  settings!: CoSyncSettings;
  
  // Collaborative state variables
  private ydoc: Y.Doc | null = null;
  private wsProvider: WebsocketProvider | null = null;
  private activeFile: TFile | null = null;
  
  // Safeguard flag to avoid infinite update loops
  private isApplyingRemoteUpdate = false;
  
  // CodeMirror 6 configuration compartment
  private yjsCompartment = new Compartment();

  async onload() {
    console.log('Loading CoSync Collaboration Plugin...');
    await this.loadSettings();

    // Register setting tab
    this.addSettingTab(new CoSyncSettingTab(this.app, this));

    // Register the dynamic CodeMirror 6 extension
    // We register an empty extension compartment initially
    this.registerEditorExtension(this.yjsCompartment.of([]));

    // Monitor note file switches
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.handleFileSwitch())
    );

    // Monitor external file modifications (Git, VSCode, other sync tools)
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) {
          this.handleExternalModification(file);
        }
      })
    );

    // Initial check
    this.handleFileSwitch();
  }

  onunload() {
    console.log('Unloading CoSync Plugin...');
    this.disconnectActive();
  }

  /**
   * Shuts down previous WebSocket links and releases Y.Doc allocations.
   */
  private disconnectActive() {
    if (this.wsProvider) {
      console.log('Disconnecting from active WebSocket room...');
      try {
        this.wsProvider.disconnect();
        this.wsProvider.destroy();
      } catch (err) {
        console.error('Error destroying WebsocketProvider:', err);
      }
      this.wsProvider = null;
    }

    if (this.ydoc) {
      this.ydoc.destroy();
      this.ydoc = null;
    }

    this.activeFile = null;
  }

  /**
   * Binds the current active note to the server.
   */
  private async handleFileSwitch() {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
      this.disconnectActive();
      return;
    }

    const file = activeView.file;
    if (!file || (this.activeFile && this.activeFile.path === file.path)) {
      return; // No change
    }

    // Disconnect existing session
    this.disconnectActive();
    this.activeFile = file;

    if (!this.settings.token) {
      console.warn('CoSync: JWT authentication token is missing. Please configure in settings.');
      return;
    }

    const documentId = this.getDocumentIdForFile(file);
    const wsUrl = this.settings.serverUrl.replace(/^http/, 'ws');
    const roomName = `/workspace/${this.settings.workspaceId}/doc/${documentId}`;

    console.log(`Connecting to collaborative room: ${roomName}`);

    // Initialize Y.Doc & WS Connection
    this.ydoc = new Y.Doc();
    this.wsProvider = new WebsocketProvider(wsUrl, roomName, this.ydoc, {
      connect: true,
      protocols: ['co-sync-auth', this.settings.token]
    });

    // Configure reconnect backoff
    this.wsProvider.maxBackoffTime = 30000;

    // Set local awareness identifier
    this.wsProvider.awareness.setLocalStateField('user', {
      name: this.app.vault.getName() || 'Obsidian Client',
      color: '#10b981', // Emerald Cursor
      userId: 'obsidian-client'
    });

    const ytext = this.ydoc.getText('codemirror');

    // Sync remote text back to vault file
    ytext.observe(() => {
      this.syncYDocToLocalFile();
    });

    // Reconfigure CodeMirror 6 with the Yjs yCollab extension
    const extension: Extension = yCollab(ytext, this.wsProvider.awareness);
    
    // Inject the extension into active editor view using compartments
    const editor = activeView.editor as any;
    if (editor && editor.cm) {
      const cmView = editor.cm as EditorView;
      cmView.dispatch({
        effects: this.yjsCompartment.reconfigure(extension)
      });
    }

    // Populate initial text if note contains data
    const fileContent = await this.app.vault.read(file);
    if (fileContent && ytext.toString() === '') {
      // Initialize Y.Doc with current file contents if empty on load
      this.ydoc.transact(() => {
        ytext.insert(0, fileContent);
      }, 'local-init');
    }
  }

  /**
   * Helper: Generates a sanitized document ID from note file metadata.
   */
  private getDocumentIdForFile(file: TFile): string {
    // Standardize file paths to avoid character conflicts in room URL strings
    const rawPath = `${this.settings.workspaceId}/${file.path}`;
    // A simple hash function to make a unique, URL-safe alphanumeric ID
    let hash = 0;
    for (let i = 0; i < rawPath.length; i++) {
      hash = (hash << 5) - hash + rawPath.charCodeAt(i);
      hash |= 0;
    }
    return 'obs-' + Math.abs(hash).toString(36) + '-' + file.basename.replace(/[^a-zA-Z0-9]/g, '');
  }

  /**
   * Writes remote Yjs state changes back to the active vault file.
   */
  private async syncYDocToLocalFile() {
    if (!this.activeFile || !this.ydoc) return;
    
    const ytext = this.ydoc.getText('codemirror').toString();

    try {
      const currentContent = await this.app.vault.read(this.activeFile);
      if (ytext !== currentContent) {
        // SAFEGUARD: Set flag so that vault.on('modify') does not treat this write
        // as a local edit transaction and recursively push it back to the server.
        this.isApplyingRemoteUpdate = true;
        await this.app.vault.modify(this.activeFile, ytext);
        this.isApplyingRemoteUpdate = false;
      }
    } catch (error) {
      this.isApplyingRemoteUpdate = false;
      console.error('Failed to sync YDoc content to local vault note', error);
    }
  }

  /**
   * Handles external note file modifications (e.g. Git pull, third-party editor).
   * CONFLICT RESOLUTION: We calculate text modifications and apply them as a local
   * transaction to Y.Doc, which handles CRDT reconciliation automatically.
   */
  private async handleExternalModification(file: TFile) {
    // Only check if it matches our active note and is NOT a write from the remote sync listener
    if (!this.activeFile || this.activeFile.path !== file.path || this.isApplyingRemoteUpdate || !this.ydoc) {
      return;
    }

    try {
      const newText = await this.app.vault.read(file);
      const ytext = this.ydoc.getText('codemirror');
      const currentYText = ytext.toString();

      if (newText !== currentYText) {
        console.log('External note modification detected (Git/VSCode). Reconciling via Yjs...');
        
        // Simple replacements inside a transaction.
        // Yjs CRDT logic automatically merges this replacement with other active cursors.
        this.ydoc.transact(() => {
          ytext.delete(0, ytext.length);
          ytext.insert(0, newText);
        }, 'external-modification');
      }
    } catch (err) {
      console.error('Failed to reconcile external vault file modification', err);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.handleFileSwitch(); // Reload connection with new configurations
  }
}

// Settings dashboard
class CoSyncSettingTab extends PluginSettingTab {
  plugin: CoSyncPlugin;

  constructor(app: App, plugin: CoSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'CoSync Collaborative Settings' });

    new Setting(containerEl)
      .setName('CoSync Server Address')
      .setDesc('Enter the URL of the collaborative server (e.g., http://localhost:4000)')
      .addText(text => text
        .setPlaceholder('http://localhost:4000')
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async (value) => {
          this.plugin.settings.serverUrl = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Authentication JWT Token')
      .setDesc('Enter the JWT token provided by the web interface')
      .addText(text => text
        .setPlaceholder('Paste your JWT token here')
        .setValue(this.plugin.settings.token)
        .onChange(async (value) => {
          this.plugin.settings.token = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Workspace ID')
      .setDesc('Specify the workspace identifier to synchronize within')
      .addText(text => text
        .setPlaceholder('ws-default')
        .setValue(this.plugin.settings.workspaceId)
        .onChange(async (value) => {
          this.plugin.settings.workspaceId = value;
          await this.plugin.saveSettings();
        }));
  }
}
