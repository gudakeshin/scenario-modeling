"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { captureException } from "@/lib/errorReporter";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

/**
 * Class error boundary — catches render errors in the subtree and reports them.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message || "Something went wrong" };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    captureException(error, { componentStack: info.componentStack ?? undefined });
  }

  private handleRetry = () => {
    this.setState({ hasError: false, message: "" });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          role="alert"
          className="m-4 rounded-xl border border-[var(--danger)]/30 bg-[var(--danger-bg)] p-6 text-center"
        >
          <p className="text-sm font-semibold text-[var(--danger)] mb-1">Something went wrong</p>
          <p className="text-xs text-[var(--text-secondary)] mb-4">{this.state.message}</p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
