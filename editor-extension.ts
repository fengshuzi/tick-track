import { editorLivePreviewField, MarkdownView } from 'obsidian';
import { EditorView, Decoration, ViewPlugin, WidgetType, DecorationSet, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import type TimeTrackingPlugin from './main';

// 支持的任务状态
type TodoStatus = 'TODO' | 'DOING' | 'LATER' | 'NOW' | 'DONE' | 'CANCELED';

const TODO_REGEX = /^(\s*(?:[-*+]|\d+\.)\s+)?(TODO|DOING|LATER|NOW|DONE|CANCELED)(?:\s+\d{2}:\d{2})?(?:\s*<!--[^>]*-->)?\s*(.*)$/;

/**
 * 复选框 Widget - 替换 TODO 关键词
 */
class TodoCheckboxWidget extends WidgetType {
  constructor(
    private status: TodoStatus,
    private plugin: TimeTrackingPlugin,
    private from: number,
    private to: number,
    private lineText: string
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'task-list-item-checkbox time-tracking-live-checkbox';
    checkbox.checked = this.status === 'DONE' || this.status === 'CANCELED';
    checkbox.dataset.status = this.status;

    const handleClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      
      if (this.status === 'DOING') {
        const line = view.state.doc.lineAt(this.from);
        const lineNumber = line.number - 1;
        
        const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
          const editor = activeView.editor;
          editor.setCursor({ line: lineNumber, ch: 0 });
          this.plugin.toggleTaskStatus(editor);
        }
      } else {
        const newStatus = this.status === 'DONE' ? 'TODO' : 'DONE';
        
        view.dispatch({
          changes: {
            from: this.from,
            to: this.to,
            insert: newStatus
          }
        });
      }
    };
    
    checkbox.addEventListener('mousedown', handleClick, true);
    checkbox.addEventListener('click', handleClick, true);

    return checkbox;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 状态标签 Widget
 */
class TodoStatusWidget extends WidgetType {
  constructor(private status: TodoStatus) {
    super();
  }

  toDOM(): HTMLElement {
    const label = document.createElement('span');
    label.className = `time-tracking-status-badge time-tracking-status-${this.status.toLowerCase()}`;
    label.textContent = this.status;
    return label;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * 创建装饰器
 */
function createDecorations(view: EditorView, plugin: TimeTrackingPlugin): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  
  if (!view.state.field(editorLivePreviewField)) {
    return builder.finish();
  }

  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos);
      const lineText = line.text;
      const match = lineText.match(TODO_REGEX);

      if (match) {
        const [, listMarker, status, content] = match;
        const listMarkerLen = listMarker ? listMarker.length : 0;
        const statusStart = line.from + listMarkerLen;
        const statusEnd = statusStart + status.length;

        builder.add(
          statusStart,
          statusEnd,
          Decoration.replace({
            widget: new TodoCheckboxWidget(
              status as TodoStatus,
              plugin,
              statusStart,
              statusEnd,
              lineText
            )
          })
        );

        if (plugin.settings.showStatusLabel && status !== 'TODO' && status !== 'DONE') {
          builder.add(
            statusEnd,
            statusEnd,
            Decoration.widget({
              widget: new TodoStatusWidget(status as TodoStatus),
              side: 1
            })
          );
        }

        // 隐藏 HTML 时间注释
        const statusEndInLine = listMarkerLen + status.length;
        const afterStatusText = lineText.substring(statusEndInLine);
        
        const timeAndCommentMatch = afterStatusText.match(/^(\s+\d{2}:\d{2})?\s*(<!--\s*ts:[^>]*?-->)/);
        
        if (timeAndCommentMatch) {
          const commentStartInAfterStatus = afterStatusText.indexOf(timeAndCommentMatch[2]);
          const commentStart = line.from + statusEndInLine + commentStartInAfterStatus;
          const commentEnd = commentStart + timeAndCommentMatch[2].length;
          
          builder.add(
            commentStart,
            commentEnd,
            Decoration.mark({
              class: 'time-tracking-comment-hidden',
              inclusive: false
            })
          );
        } else {
          const contentCommentMatch = content.match(/<!--\s*ts:[^>]*?-->/);
          if (contentCommentMatch) {
            const commentStartInContent = content.indexOf(contentCommentMatch[0]);
            const commentStart = statusEnd + 1 + commentStartInContent;
            const commentEnd = commentStart + contentCommentMatch[0].length;
            
            builder.add(
              commentStart,
              commentEnd,
              Decoration.mark({
                class: 'time-tracking-comment-hidden',
                inclusive: false
              })
            );
          }
        }

        // 完成状态删除线
        if ((status === 'DONE' || status === 'CANCELED') && plugin.settings.enableStrikethrough) {
          const contentStart = statusEnd + 1;
          builder.add(
            contentStart,
            line.to,
            Decoration.mark({
              class: 'time-tracking-completed'
            })
          );
        }
      }

      pos = line.to + 1;
    }
  }

  return builder.finish();
}

/**
 * 创建编辑器扩展
 */
export function createTimeTrackingExtension(plugin: TimeTrackingPlugin) {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = createDecorations(view, plugin);
        }

        update(update: ViewUpdate): void {
          if (update.docChanged || update.viewportChanged || update.selectionSet) {
            this.decorations = createDecorations(update.view, plugin);
          }
        }
      },
      {
        decorations: (v) => v.decorations
      }
    ),
    EditorView.baseTheme({
      '.time-tracking-live-checkbox': {
        cursor: 'pointer',
        margin: '0 0.3em 0 0',
        verticalAlign: 'middle'
      },
      '.time-tracking-status-badge': {
        display: 'inline-block',
        padding: '0.1em 0.4em',
        marginLeft: '0.3em',
        fontSize: '0.7em',
        fontWeight: '600',
        borderRadius: '3px',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        verticalAlign: 'middle'
      },
      '.time-tracking-status-doing': {
        backgroundColor: 'var(--time-tracking-doing-color, #ff9800)',
        color: 'white'
      },
      '.time-tracking-status-later': {
        backgroundColor: 'var(--time-tracking-later-color, #2196f3)',
        color: 'white'
      },
      '.time-tracking-status-now': {
        backgroundColor: 'var(--time-tracking-now-color, #f44336)',
        color: 'white'
      },
      '.time-tracking-completed': {
        opacity: '0.8'
      },
      '.time-tracking-comment-hidden': {
        display: 'none'
      }
    })
  ];
}
