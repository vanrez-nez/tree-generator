import type { GraphLineStyle } from "./line";
import type { LineTubeOptions } from "./line-tube";
import type { ModifierEnvelope } from "./modifiers/modifier";
import type { CoilModifierParams } from "./modifiers/coil";
import type { DiscAlignModifierParams } from "./modifiers/disc-align";
import type { FootAlignModifierParams } from "./modifiers/foot-align";
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

export type FootAlignModifierDocument = {
  type: "footAlign";
  enabled?: boolean;
  envelope?: ModifierEnvelope;
  params?: Partial<FootAlignModifierParams>;
};

export type DiscAlignModifierDocument = {
  type: "discAlign";
  enabled?: boolean;
  envelope?: ModifierEnvelope;
  params?: Partial<DiscAlignModifierParams>;
};

export type ModifierDocument =
  | SmoothModifierDocument
  | GnarlModifierDocument
  | TwistModifierDocument
  | CoilModifierDocument
  | FootAlignModifierDocument
  | DiscAlignModifierDocument;

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
  tube?: LineTubeOptions;
};

export type JointDocument = {
  id: string;
  parentLineId: string;
  parentT: number;
  childLineId: string;
  childPointIndex: number;
  maxLeanAngle?: number;
  directionPoints?: number;
};

export type GraphDocument = {
  lines: GraphLineDocument[];
  joints: JointDocument[];
};
