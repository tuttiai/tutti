import { registerWidget, lookupWidget } from "../core/widget-registry.js";
import type { WidgetDefinition } from "../core/widget-registry.js";

export function betaFeature(): WidgetDefinition | undefined {
  registerWidget({ widgetName: "beta" });
  return lookupWidget("beta");
}
