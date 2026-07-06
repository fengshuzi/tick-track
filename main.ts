import { Plugin, Editor, MarkdownView, PluginSettingTab, Setting, App, MarkdownPostProcessorContext, TFile } from 'obsidian';
import { createTimeTrackingExtension } from './editor-extension';

interface TimeTrackingSettings {
  autoAppendDuration: boolean;
  durationPosition: 'end' | 'afterStatus';
  registerHotkey: boolean;
  enableLivePreview: boolean;
  enableReadingMode: boolean;
  showStatusLabel: boolean;
  enableStrikethrough: boolean;
  openTodayNoteAfterToggle: boolean;
}

interface DailyNotesPluginInstance {
  options?: {
    folder?: string;
    format?: string;
  };
}

interface DailyNotesPlugin {
  enabled?: boolean;
  instance?: DailyNotesPluginInstance;
}

interface InternalPlugins {
  plugins?: Record<string, DailyNotesPlugin>;
}

interface AppWithInternal extends App {
  internalPlugins?: InternalPlugins;
}

const DEFAULT_SETTINGS: TimeTrackingSettings = {
  autoAppendDuration: true,
  durationPosition: 'end',
  registerHotkey: true,
  enableLivePreview: true,
  enableReadingMode: false,
  showStatusLabel: true,
  enableStrikethrough: false,
  openTodayNoteAfterToggle: false
};

export default class TimeTrackingPlugin extends Plugin {
  settings: TimeTrackingSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    if (this.settings.enableReadingMode) {
      this.registerMarkdownPostProcessor((el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        this.postProcessor(el, ctx);
      });
    }

    if (this.settings.enableLivePreview) {
      this.registerEditorExtension(createTimeTrackingExtension(this));
    }

    this.addCommand({
      id: 'toggle-task-status',
      name: 'Toggle task status and track time',
      editorCallback: (editor: Editor) => {
        this.toggleTaskStatus(editor);
      }
    });

    this.addCommand({
      id: 'toggle-last-task-today',
      name: 'Toggle last task in today\'s daily note',
      callback: () => {
        void this.toggleLastTaskInTodayNote();
      }
    });

    this.addRibbonIcon('play', 'Toggle last task in today\'s note', () => {
      void this.toggleLastTaskInTodayNote();
    });

    this.addSettingTab(new TimeTrackingSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as TimeTrackingSettings;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  postProcessor(element: HTMLElement, _context: MarkdownPostProcessorContext): void {
    if (!this.settings.enableReadingMode) return;

    const listItems = element.querySelectorAll('li');
    listItems.forEach((li) => {
      if (li instanceof HTMLElement) {
        this.processListItem(li);
      }
    });
  }

  processListItem(li: HTMLElement): void {
    const text = li.textContent || '';
    const match = text.match(/^(TODO|DOING|LATER|NOW|DONE|CANCELED)(?:\s+\d{2}:\d{2})?(?:\s*<!--[^>]*-->)?\s*(.*)$/);

    if (match) {
      const [, status, content] = match;
      const checkbox = this.createCheckbox(status as 'TODO' | 'DOING' | 'LATER' | 'NOW' | 'DONE' | 'CANCELED', content);
      li.empty();
      li.appendChild(checkbox);
      li.classList.add('time-tracking-list-item');
    }
  }

  createCheckbox(status: 'TODO' | 'DOING' | 'LATER' | 'NOW' | 'DONE' | 'CANCELED', content: string): HTMLElement {
    const container = document.createElement('span');
    container.className = 'time-tracking-item';
    container.dataset.status = status;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'task-list-item-checkbox time-tracking-checkbox';
    checkbox.checked = status === 'DONE' || status === 'CANCELED';
    checkbox.disabled = true;

    container.classList.add(`time-tracking-status-${status.toLowerCase()}`);

    if (this.settings.showStatusLabel && status !== 'TODO' && status !== 'DONE') {
      const statusLabel = document.createElement('span');
      statusLabel.className = 'time-tracking-status-label';
      statusLabel.textContent = status;
      container.appendChild(statusLabel);
    }

    const label = document.createElement('span');
    label.className = 'time-tracking-content';

    const cleanContent = content.replace(/<!--\s*ts:[^>]*?-->/g, '').trim();
    label.textContent = cleanContent;

    container.appendChild(checkbox);
    container.appendChild(label);

    return container;
  }

  formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
    return `${Math.floor(seconds / 3600)}小时`;
  }

  formatStartTime(isoString: string): string {
    const date = new Date(isoString);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  extractTrackingInfo(line: string): { startTime: string; source: 'todo' | 'checkbox' } | null {
    const newMatch = line.match(/DOING\s+(?:\d{2}:\d{2}\s+)?<!--\s*ts:([^|]+)\|source:(\w+)\s*-->/);
    if (newMatch) {
      return {
        startTime: newMatch[1],
        source: newMatch[2] as 'todo' | 'checkbox'
      };
    }

    const oldMatch = line.match(/<!--\s*ts:([^|]+)\|source:(\w+)\s*-->/);
    if (oldMatch) {
      return {
        startTime: oldMatch[1],
        source: oldMatch[2] as 'todo' | 'checkbox'
      };
    }

    const legacyMatch = line.match(/<!--\s*ts:([^>]+?)\s*-->/);
    if (legacyMatch) {
      return {
        startTime: legacyMatch[1],
        source: 'todo'
      };
    }
    return null;
  }

  removeTimeComment(line: string): string {
    return line.replace(/\s*<!--\s*ts:[^>]*?-->\s*/g, '');
  }

  removeDuration(line: string): string {
    return line.replace(/\s+\d+(秒|分钟|小时)$/, '');
  }

  toggleTaskStatus(editor: Editor) {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);

    const cleanedLine = this.removeTimeComment(line);

    // 1. 原生 markdown 复选框
    const checkboxMatch = cleanedLine.match(/^(\s*)([-*+]|\d+\.)\s+\[([ xX])\]\s+(.*)$/);
    if (checkboxMatch) {
      const [, indent, marker, checkState, content] = checkboxMatch;

      if (checkState === ' ') {
        const startTime = new Date().toISOString();
        const displayTime = this.formatStartTime(startTime);
        const existingTimeMatch = content.match(/^(\d{2}:\d{2})\s+(.*)$/);
        const taskContent = existingTimeMatch ? existingTimeMatch[2] : content;
        const newLine = `${indent}${marker} DOING ${displayTime} <!-- ts:${startTime}|source:checkbox --> ${taskContent}`;
        editor.setLine(cursor.line, newLine);
      } else {
        const newLine = `${indent}${marker} ${content}`;
        editor.setLine(cursor.line, newLine);
      }
      return;
    }

    // 2. 任务状态
    const todoMatch = cleanedLine.match(/^(\s*)([-*+]|\d+\.)\s+(TODO)\s+(.*)$/);
    const doingMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(DOING)\s+(?:\d{2}:\d{2}\s+)?(?:<!--[^>]*-->)?\s*(.*)$/);
    const doneMatch = cleanedLine.match(/^(\s*)([-*+]|\d+\.)\s+(DONE)\s+(?:\d{2}:\d{2}\s+)?(.*)$/);

    let newLine = '';

    if (todoMatch) {
      const [, indent, marker, , content] = todoMatch;
      const startTime = new Date().toISOString();
      const displayTime = this.formatStartTime(startTime);
      const existingTimeMatch = content.match(/^(\d{2}:\d{2})\s+(.*)$/);
      const taskContent = existingTimeMatch ? existingTimeMatch[2] : content;

      if (taskContent.trim()) {
        newLine = `${indent}${marker} DOING ${displayTime} <!-- ts:${startTime}|source:todo --> ${taskContent}`;
      } else {
        newLine = `${indent}${marker} DOING ${displayTime} <!-- ts:${startTime}|source:todo -->`;
      }

    } else if (doingMatch) {
      const [, indent, marker, , content] = doingMatch;
      const startTimeMatch = line.match(/DOING\s+(\d{2}:\d{2})/);
      const startTimeDisplay = startTimeMatch ? startTimeMatch[1] : null;
      const trackingInfo = this.extractTrackingInfo(line);

      if (trackingInfo) {
        const start = new Date(trackingInfo.startTime);
        const end = new Date();
        const durationSeconds = Math.floor((end.getTime() - start.getTime()) / 1000);
        const durationStr = this.formatDuration(durationSeconds);
        const taskText = this.removeTimeComment(content).trim();

        if (trackingInfo.source === 'checkbox') {
          newLine = this.buildCompletedLine(indent, marker, '[x]', startTimeDisplay, taskText, durationStr);
        } else {
          newLine = this.buildCompletedLine(indent, marker, 'DONE', startTimeDisplay, taskText, durationStr);
        }
      } else {
        const taskText = this.removeTimeComment(content).trim();
        newLine = taskText ? `${indent}${marker} DONE ${taskText}` : `${indent}${marker} DONE`;
      }

    } else if (doneMatch) {
      const [, indent, marker, , content] = doneMatch;
      const taskText = this.removeDuration(content).trim();
      newLine = taskText ? `${indent}${marker} ${taskText}` : `${indent}${marker} `;

    } else {
      const listMatch = cleanedLine.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);

      if (listMatch) {
        const [, indent, marker, content] = listMatch;
        newLine = content.trim() ? `${indent}${marker} TODO ${content}` : `${indent}${marker} TODO `;
      } else {
        const indent = cleanedLine.match(/^(\s*)/)?.[1] || '';
        newLine = cleanedLine.trim() ? `${indent}- TODO ${cleanedLine.trim()}` : `${indent}- TODO `;
      }
    }

    editor.setLine(cursor.line, newLine);
  }

  private buildCompletedLine(indent: string, marker: string, statusMark: string, startTimeDisplay: string | null, taskText: string, durationStr: string): string {
    const timePrefix = startTimeDisplay ? `${startTimeDisplay} ` : '';

    if (this.settings.autoAppendDuration && taskText) {
      if (this.settings.durationPosition === 'end') {
        return `${indent}${marker} ${statusMark} ${timePrefix}${taskText} ${durationStr}`;
      }
      return `${indent}${marker} ${statusMark} ${timePrefix}${durationStr} ${taskText}`;
    }

    if (this.settings.autoAppendDuration && !taskText) {
      return `${indent}${marker} ${statusMark} ${timePrefix}${durationStr}`;
    }

    if (taskText) {
      return `${indent}${marker} ${statusMark} ${timePrefix}${taskText}`;
    }

    return startTimeDisplay
      ? `${indent}${marker} ${statusMark} ${startTimeDisplay}`
      : `${indent}${marker} ${statusMark}`;
  }

  isTaskLine(line: string): boolean {
    const todoPattern = /^(\s*)([-*+]|\d+\.)\s+(TODO|DOING|DONE|LATER|NOW|CANCELED)\s/;
    if (todoPattern.test(line)) return true;

    const checkboxPattern = /^(\s*)([-*+]|\d+\.)\s+\[[ xX]\]\s/;
    return checkboxPattern.test(line);
  }

  getTodayNotePath(): string {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    
const app = this.app as AppWithInternal;
    const dailyNotesPlugin = app.internalPlugins?.plugins?.['daily-notes'];
    if (dailyNotesPlugin?.enabled) {
      const config = dailyNotesPlugin.instance?.options || {};
      const folder: string = config.folder || '';
      const format: string = config.format || 'YYYY-MM-DD';
      
      const fileName = format
        .replace('YYYY', String(year))
        .replace('MM', month)
        .replace('DD', day);
      
      return folder ? `${folder}/${fileName}.md` : `${fileName}.md`;
    }
    
    return `${year}-${month}-${day}.md`;
  }

  async toggleLastTaskInTodayNote() {
    const todayPath = this.getTodayNotePath();
    const todayFile = this.app.vault.getAbstractFileByPath(todayPath);
    
    if (!(todayFile instanceof TFile)) return;

    const content = await this.app.vault.read(todayFile);
    const lines = content.split('\n');

    let targetLine = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (this.isTaskLine(lines[i])) {
        targetLine = i;
        break;
      }
    }

    if (targetLine === -1) return;

    lines[targetLine] = this.toggleTaskStatusInLine(lines[targetLine]);
    await this.app.vault.modify(todayFile, lines.join('\n'));

    if (this.settings.openTodayNoteAfterToggle) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(todayFile);
      
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) {
        view.editor.setCursor({ line: targetLine, ch: 0 });
      }
    }
  }

  private toggleTaskStatusInLine(line: string): string {
    const cleanedLine = this.removeTimeComment(line);

    const checkboxMatch = cleanedLine.match(/^(\s*)([-*+]|\d+\.)\s+\[([ xX])\]\s+(.*)$/);
    if (checkboxMatch) {
      const [, indent, marker, checkState, content] = checkboxMatch;
      
      if (checkState === ' ') {
        const startTime = new Date().toISOString();
        const displayTime = this.formatStartTime(startTime);
        const existingTimeMatch = content.match(/^(\d{2}:\d{2})\s+(.*)$/);
        const taskContent = existingTimeMatch ? existingTimeMatch[2] : content;
        return `${indent}${marker} DOING ${displayTime} <!-- ts:${startTime}|source:checkbox --> ${taskContent}`;
      }
      return `${indent}${marker} ${content}`;
    }

    const todoMatch = cleanedLine.match(/^(\s*)([-*+]|\d+\.)\s+(TODO)\s+(.*)$/);
    const doingMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(DOING)\s+(?:\d{2}:\d{2}\s+)?(?:<!--[^>]*-->)?\s*(.*)$/);
    const doneMatch = cleanedLine.match(/^(\s*)([-*+]|\d+\.)\s+(DONE)\s+(?:\d{2}:\d{2}\s+)?(.*)$/);

    if (todoMatch) {
      const [, indent, marker, , content] = todoMatch;
      const startTime = new Date().toISOString();
      const displayTime = this.formatStartTime(startTime);
      const existingTimeMatch = content.match(/^(\d{2}:\d{2})\s+(.*)$/);
      const taskContent = existingTimeMatch ? existingTimeMatch[2] : content;
      
      return taskContent.trim()
        ? `${indent}${marker} DOING ${displayTime} <!-- ts:${startTime}|source:todo --> ${taskContent}`
        : `${indent}${marker} DOING ${displayTime} <!-- ts:${startTime}|source:todo -->`;
      
    } else if (doingMatch) {
      const [, indent, marker, , content] = doingMatch;
      const startTimeMatch = line.match(/DOING\s+(\d{2}:\d{2})/);
      const startTimeDisplay = startTimeMatch ? startTimeMatch[1] : null;
      const trackingInfo = this.extractTrackingInfo(line);

      if (trackingInfo) {
        const start = new Date(trackingInfo.startTime);
        const end = new Date();
        const durationSeconds = Math.floor((end.getTime() - start.getTime()) / 1000);
        const durationStr = this.formatDuration(durationSeconds);
        const taskText = this.removeTimeComment(content).trim();

        if (trackingInfo.source === 'checkbox') {
          return this.buildCompletedLine(indent, marker, '[x]', startTimeDisplay, taskText, durationStr);
        }
        return this.buildCompletedLine(indent, marker, 'DONE', startTimeDisplay, taskText, durationStr);
      }
      const taskText = this.removeTimeComment(content).trim();
      return taskText ? `${indent}${marker} DONE ${taskText}` : `${indent}${marker} DONE`;
      
    } else if (doneMatch) {
      const [, indent, marker, , content] = doneMatch;
      const taskText = this.removeDuration(content).trim();
      return taskText ? `${indent}${marker} ${taskText}` : `${indent}${marker} `;
      
    } else {
      const listMatch = cleanedLine.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
      
      if (listMatch) {
        const [, indent, marker, content] = listMatch;
        return content.trim() 
          ? `${indent}${marker} TODO ${content}`
          : `${indent}${marker} TODO `;
      }
      const indent = cleanedLine.match(/^(\s*)/)?.[1] || '';
      return cleanedLine.trim()
        ? `${indent}- TODO ${cleanedLine.trim()}`
        : `${indent}- TODO `;
    }
  }
}

class TimeTrackingSettingTab extends PluginSettingTab {
  plugin: TimeTrackingPlugin;

  constructor(app: App, plugin: TimeTrackingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('注册快捷键')
      .setDesc('启用后自动绑定 Cmd+Enter 快捷键。如果与其他插件冲突，可以关闭此选项（需要重启）')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.registerHotkey)
        .onChange(async (value) => {
          this.plugin.settings.registerHotkey = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('启用实时预览渲染')
      .setDesc('在实时预览模式中将任务状态渲染为复选框（需要重启）')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableLivePreview)
        .onChange(async (value) => {
          this.plugin.settings.enableLivePreview = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('启用阅读模式渲染')
      .setDesc('在阅读模式中将任务状态渲染为复选框')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableReadingMode)
        .onChange(async (value) => {
          this.plugin.settings.enableReadingMode = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('显示状态标签')
      .setDesc('显示进行中、稍后、立即等状态标签')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showStatusLabel)
        .onChange(async (value) => {
          this.plugin.settings.showStatusLabel = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('启用删除线')
      .setDesc('为已完成和已取消的任务添加删除线样式')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableStrikethrough)
        .onChange(async (value) => {
          this.plugin.settings.enableStrikethrough = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('自动追加时长')
      .setDesc('完成任务时自动在任务末尾追加耗时')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoAppendDuration)
        .onChange(async (value) => {
          this.plugin.settings.autoAppendDuration = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('时长显示位置')
      .setDesc('选择时长显示在任务文本的位置')
      .addDropdown(dropdown => dropdown
        .addOption('end', '任务末尾')
        .addOption('afterStatus', '状态后面')
        .setValue(this.plugin.settings.durationPosition)
        .onChange(async (value: string) => {
          this.plugin.settings.durationPosition = value as 'end' | 'afterStatus';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('切换任务后打开文件')
      .setDesc('点击侧边栏按钮切换任务状态后，是否自动打开该文件并定位到任务行')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.openTodayNoteAfterToggle)
        .onChange(async (value) => {
          this.plugin.settings.openTodayNoteAfterToggle = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName('Support').setHeading();

    const donateSection = containerEl.createDiv({ cls: 'plugin-donate-section' });
    donateSection.createEl('p', { text: '如果这个插件帮助了你，欢迎请作者喝杯咖啡 ☕', cls: 'plugin-donate-desc' });
    const imgWrap = donateSection.createDiv({ cls: 'plugin-donate-qr' });
    const imgSrc = "https://raw.githubusercontent.com/fengshuzi/images/main/wechat-donate.jpg";
    const donateImg = imgWrap.createEl('img', { attr: { src: imgSrc, alt: '微信打赏' }, cls: 'plugin-donate-img' });
    donateImg.addEventListener('click', () => {
        const overlay = document.body.createDiv({ cls: 'plugin-donate-lightbox' });
        overlay.createEl('img', { attr: { src: imgSrc, alt: '微信打赏' }, cls: 'plugin-donate-lightbox-img' });
        overlay.addEventListener('click', () => overlay.remove());
    });
    imgWrap.createEl('p', { text: '微信扫码', cls: 'plugin-donate-label' });
  }
}
