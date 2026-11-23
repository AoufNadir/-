interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export interface PWAState {
  isInstallable: boolean;
  isInstalled: boolean;
  isIOS: boolean;
  isOnline: boolean;
}

type Listener = (state: PWAState) => void;

class PWAManager {
  private deferredPrompt: BeforeInstallPromptEvent | null = null;
  private listeners = new Set<Listener>();
  public state: PWAState = {
    isInstallable: false,
    isInstalled: false,
    isIOS: false,
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  };

  constructor() {
    if (typeof window === 'undefined') return;
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    const ua = window.navigator.userAgent.toLowerCase();
    const isIOS = /iphone|ipad|ipod/.test(ua);

    this.state = {
      isInstallable: false,
      isInstalled: isStandalone,
      isIOS,
      isOnline: navigator.onLine,
    };

    window.addEventListener('beforeinstallprompt', (e: Event) => {
      e.preventDefault();
      this.deferredPrompt = e as BeforeInstallPromptEvent;
      this.update({ isInstallable: true });
    });

    window.addEventListener('appinstalled', () => {
      this.deferredPrompt = null;
      this.update({ isInstalled: true, isInstallable: false });
    });

    window.addEventListener('online', () => this.update({ isOnline: true }));
    window.addEventListener('offline', () => this.update({ isOnline: false }));
  }

  private update(patch: Partial<PWAState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) {
      try {
        fn(this.state);
      } catch {
        // ignore listener errors
      }
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  async install(): Promise<boolean> {
    if (!this.deferredPrompt) return false;
    await this.deferredPrompt.prompt();
    const { outcome } = await this.deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      this.deferredPrompt = null;
      this.update({ isInstalled: true, isInstallable: false });
      return true;
    }
    return false;
  }
}

export const pwaManager = new PWAManager();
