import { registerWidget, lookupWidget } from "../core/widget-registry.js";
import type { WidgetDefinition } from "../core/widget-registry.js";

export function deltaFeature(): WidgetDefinition | undefined {
  registerWidget({ widgetName: "delta" });
  return lookupWidget("delta");
}
