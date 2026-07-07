import React from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

// ── Global boundary (full-screen) — wraps the entire app ─────────────────────

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="flex justify-center">
            <div className="bg-destructive/10 text-destructive p-4 rounded-full">
              <AlertTriangle className="w-10 h-10" />
            </div>
          </div>

          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight">Something went wrong</h1>
            <p className="text-muted-foreground text-sm">
              An unexpected error occurred in the explorer. Your wallet and funds are not affected.
            </p>
          </div>

          {this.state.error && (
            <div className="rounded-lg border bg-muted/40 px-4 py-3 text-left overflow-auto max-h-32">
              <p className="font-mono text-xs text-destructive break-all">
                {this.state.error.message}
              </p>
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button onClick={this.handleReset} className="flex items-center gap-2">
              <RotateCcw className="w-4 h-4" />
              Try again
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload page
            </Button>
          </div>
        </div>
      </div>
    );
  }
}

// ── Route boundary (inline) — wraps a single page; nav stays visible ─────────

class RouteErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[RouteErrorBoundary]", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex flex-col items-center justify-center py-24 px-6 text-center space-y-5">
        <div className="bg-destructive/10 text-destructive p-3 rounded-full">
          <AlertTriangle className="w-8 h-8" />
        </div>

        <div className="space-y-1.5">
          <h2 className="text-xl font-semibold tracking-tight">This page crashed</h2>
          <p className="text-muted-foreground text-sm max-w-sm">
            An unexpected error occurred. The rest of the explorer is still working.
          </p>
        </div>

        {this.state.error && (
          <div className="rounded-lg border bg-muted/40 px-4 py-3 text-left overflow-auto max-h-28 w-full max-w-md">
            <p className="font-mono text-xs text-destructive break-all">
              {this.state.error.message}
            </p>
          </div>
        )}

        <div className="flex gap-3">
          <Button size="sm" onClick={this.handleReset} className="flex items-center gap-2">
            <RotateCcw className="w-3.5 h-3.5" />
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload page
          </Button>
        </div>
      </div>
    );
  }
}

// ── HOC ───────────────────────────────────────────────────────────────────────

export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
): React.ComponentType<P> {
  const displayName = Component.displayName ?? Component.name ?? "Component";

  function Wrapped(props: P) {
    return (
      <RouteErrorBoundary>
        <Component {...props} />
      </RouteErrorBoundary>
    );
  }

  Wrapped.displayName = `withErrorBoundary(${displayName})`;
  return Wrapped;
}
