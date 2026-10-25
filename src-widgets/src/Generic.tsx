import type VisRxWidget from "@iobroker/types-vis-2/visRxWidget";
import type { VisRxWidgetState } from "@iobroker/types-vis-2";

/** Base class of all widgets of this set. The real class is provided by vis-2 at runtime. */
export default class Generic<
	T extends Record<string, unknown> = Record<string, unknown>,
	TState extends Partial<VisRxWidgetState> = VisRxWidgetState,
> extends (window.visRxWidget as typeof VisRxWidget)<T, TState> {}
