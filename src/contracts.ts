export interface Action { id: string; label: string; duration: number }
export interface Fact { id: string; text: string }
export interface Vital { minute: number; pulse: number; pressure: string; breathing: number; oxygen: number }
export interface Entry { minute: number; text: string; id: string }
export interface CaseInfo { id: string; version: number; title: string; brief: string; facility: string }
export interface SessionInfo { id: string; title: string; status: 'active' | 'finished'; created: string }
export interface Handover { minute: number; destination: string; sections: { label: string; text: string }[] }
export interface Snapshot {
  id: string; revision: number; scenario: CaseInfo; minute: number; status: SessionInfo['status'];
  condition: string; facts: Fact[]; vitals: Vital[]; receiver: string; transport: string;
  tasks: Entry[]; timeline: Entry[]; options: Action[];
  handover: { latest: Handover | null; changes: Entry[] };
}
export interface Debrief {
  outcome: string; timeline: Entry[];
  ratings: { label: string; status: 'Tercapai' | 'Sebagian' | 'Terlewat' | 'Tidak berlaku'; evidence: Entry[] }[];
}
