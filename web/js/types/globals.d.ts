//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Global type declarations for Juggler
 */

interface Window {
	/**
	 * Show an alert dialog
	 */
	showAlert(message: string, title?: string): Promise<void>;

	/**
	 * Show a confirm dialog
	 */
	showConfirm(
		message: string,
		title?: string,
		options?: { confirmText?: string; cancelText?: string; danger?: boolean }
	): Promise<boolean>;

	/**
	 * Show a prompt dialog
	 */
	showPrompt(message: string, defaultValue?: string, title?: string): Promise<string | null>;

	/**
	 * Marked markdown parser (loaded from vendor)
	 */
	marked?: {
		parse(markdown: string): string;
	};

	/**
	 * Reference to main application instance (debugging)
	 */
	jugglerApp?: unknown;

	/**
	 * Show choice dialog
	 */
	showChoice?(message: string, choices: string[], title?: string, allowCustom?: boolean): Promise<string | null>;

	/**
	 * Open settings panel
	 * @param tab - Optional tab to switch to ('providers', 'shortcuts', 'facts')
	 * @param options - Optional target to reveal inside that tab (a capability in the Extensions catalog)
	 */
	openSettings?(tab?: string, options?: { capability?: { itemType: string; id: string } }): void;

	/**
	 * Test completion flag (for headless testing)
	 */
	testComplete?: boolean;

	/**
	 * Set by server when running in test mode; causes app.js to poll for pending tests.
	 */
	JUGGLER_TEST_MODE?: boolean;

	/**
	 * Project session's saved UI zoom (root font-size %), injected pre-paint by
	 * the server. 0/absent when the session has none (see zoom-manager.js).
	 */
	__sessionZoom?: number;

	/**
	 * Project session's saved UI theme mode (system|light|dark), injected
	 * pre-paint by the server. Empty/absent when the session has none (see
	 * theme-manager.js).
	 */
	__sessionThemeMode?: string;

	/**
	 * Opaque per-project key injected pre-paint by the server, namespacing this
	 * device's stored zoom/theme so they belong to the project they were set in
	 * (see services/prefs.js). Empty/absent for a no-project window.
	 */
	__projectKey?: string;

}

/**
 * Custom element type extensions
 */
interface HTMLElementTagNameMap {
	'conversation-area': HTMLElement & {
		conversation: unknown;
		scrollToBottom(force?: boolean): void;
		scrollItemIntoView(itemId: string, opts?: { smooth?: boolean; automatic?: boolean }): void;
		applySelectedClass(selectedId: string | null): void;
		getMessageThread(): unknown;
		renderFromItems(items: unknown[], insertedMessageIds?: string[]): void;
		composer?: HTMLElement;
	};
	'model-selector': HTMLElement & {
		refresh(): void;
		setSession(session: unknown): void;
	};
	'plugin-catalog': HTMLElement & {
		show(scope: 'global' | 'local'): void;
	};
	'composer-box': HTMLElement & {
		setSession(session: unknown): void;
		focus(): void;
		isEmpty(): boolean;
	};
	'properties-panel': HTMLElement & {
		setConversation(conversation: unknown): void;
		selectItem(itemId: string | null): void;
		clearSelection(): void;
		getSelectedItemId(): string | null;
	};
}

