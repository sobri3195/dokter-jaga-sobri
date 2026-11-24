import type { CaseInfo, Fact, Vital } from '../src/contracts'

export interface Scenario {
  info: CaseInfo;
  deadline: number;
  primaryCutoff: number;
  ambulanceETA: number;
  initialVital: Omit<Vital, 'minute'>;
  reassessments: { vital: Omit<Vital, 'minute'>; finding: Fact }[];
  outcomes: { primary: string; alternate: string; deadline: string };
  events: Record<string, { priority: number; delay: number }>;
  actions: { id: string; label: string; duration: number; requires: string[] }[];
}

export const scenario: Scenario = {
  info: {
    id: 'jatuh-sore', version: 1, title: 'Jatuh Sore, Mengantuk Tengah Malam',
    brief: 'Pasien fiktif jatuh dari motor sore tadi. Keluarga melaporkan pasien makin mengantuk menjelang tengah malam.',
    facility: 'Fasilitas tanpa CT. Ambulans sedang bertugas. RS penerima perlu mengonfirmasi kesiapan.',
  },
  deadline: 60,
  primaryCutoff: 10,
  ambulanceETA: 25,
  initialVital: { pulse: 92, pressure: '128/82', breathing: 18, oxygen: 98 },
  reassessments: [
    { vital: { pulse: 104, pressure: '120/78', breathing: 22, oxygen: 96 },
      finding: { id: 'response', text: 'Saat dinilai ulang, pasien membuka mata setelah dipanggil berulang.' } },
    { vital: { pulse: 108, pressure: '118/76', breathing: 23, oxygen: 95 },
      finding: { id: 'speech', text: 'Pada penilaian berikutnya, jawaban pasien lebih singkat dari sebelumnya.' } },
  ],
  outcomes: {
    primary: 'Transfer ke RS utama selesai.',
    alternate: 'Transfer ke RS alternatif selesai.',
    deadline: 'Waktu skenario berakhir sebelum transfer terselesaikan.',
  },
  events: {
    primary: { delay: 5, priority: 10 },
    alternate: { delay: 6, priority: 10 },
    ambulance: { delay: 0, priority: 20 },
    reassess: { delay: 5, priority: 30 },
    deadline: { delay: 0, priority: 100 },
  },
  actions: [
    { id: 'primary', label: 'Delegasikan panggilan ke RS utama', duration: 0, requires: ['receiver idle', 'phone free'] },
    { id: 'alternate', label: 'Delegasikan panggilan ke RS alternatif', duration: 0, requires: ['primary unavailable', 'phone free'] },
    { id: 'reassess', label: 'Nilai ulang pasien', duration: 5, requires: ['assessment pending'] },
    { id: 'transport', label: 'Siapkan transportasi', duration: 2, requires: ['transport idle'] },
    { id: 'handover', label: 'Kirim handover simulasi', duration: 1, requires: ['receiver ready', 'handover due'] },
    { id: 'transfer', label: 'Selesaikan transfer', duration: 2, requires: ['receiver ready', 'transport ready', 'handover current', 'time available'] },
    { id: 'wait', label: 'Tunggu 5 menit', duration: 5, requires: [] },
  ],
}
