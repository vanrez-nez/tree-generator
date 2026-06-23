import type { GraphLineStyle } from "./line";
import type { ModifierEnvelope } from "./modifiers/modifier";
import type { CoilModifierParams } from "./modifiers/coil";
import type { GnarlModifierParams } from "./modifiers/gnarl";
import type { SmoothModifierParams } from "./modifiers/smooth";
import type { TwistModifierParams } from "./modifiers/twist";

export type GraphPointDocument = [number, number, number];

export type SmoothModifierDocument = {
  type: "smooth";
  enabled?: boolean;
  envelope?: ModifierEnvelope;
  params?: Partial<SmoothModifierParams>;
};

export type GnarlModifierDocument = {
  type: "gnarl";
  enabled?: boolean;
  envelope?: ModifierEnvelope;
  params?: Partial<GnarlModifierParams>;
};

export type TwistModifierDocument = {
  type: "twist";
  enabled?: boolean;
  envelope?: ModifierEnvelope;
  params?: Partial<TwistModifierParams>;
};

export type CoilModifierDocument = {
  type: "coil";
  enabled?: boolean;
  envelope?: ModifierEnvelope;
  params?: Partial<CoilModifierParams>;
};

export type ModifierDocument =
  | SmoothModifierDocument
  | GnarlModifierDocument
  | TwistModifierDocument
  | CoilModifierDocument;

export type GraphLineDocument = {
  id: string;
  color?: number | string;
  dashSize?: number;
  debugLinePointsVisible?: boolean;
  debugPointVisible?: boolean;
  debugT?: number;
  gapSize?: number;
  modifiers?: ModifierDocument[];
  points: GraphPointDocument[];
  style?: GraphLineStyle;
  thickness?: number;
};

export type JointDocument = {
  id: string;
  sourceLineId: string;
  sourceT: number;
  targetLineId: string;
  targetPointIndex: number;
};

export type GraphDocument = {
  lines: GraphLineDocument[];
  joints: JointDocument[];
};
