'use client';
import { Component, type ReactNode } from 'react';

interface State { error: Error | null; }

/**
 * 顶层 ErrorBoundary：任一 React 树抛错 → 显示降级 UI 并暴露重置按钮，
 * 避免整页白屏。生产模式下不暴露 stack trace。
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown): void {
    console.error('[ErrorBoundary]', error, info);
  }

  reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const isDev = process.env.NODE_ENV !== 'production';
    return (
      <div className="error-boundary">
        <div className="error-boundary-card">
          <h2>⚠ 页面出错了</h2>
          <p>组件渲染时抛错。可以点重试，或刷新页面。</p>
          {isDev && (
            <pre className="error-boundary-stack">
              {this.state.error.message}
              {'\n\n'}
              {this.state.error.stack}
            </pre>
          )}
          <div className="error-boundary-actions">
            <button type="button" className="modal-btn primary" onClick={this.reset}>
              重试
            </button>
            <button type="button" className="modal-btn secondary" onClick={() => location.reload()}>
              刷新页面
            </button>
          </div>
        </div>
      </div>
    );
  }
}
