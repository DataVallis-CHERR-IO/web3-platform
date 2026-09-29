import type * as React from 'react';
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'secondary' | 'ghost'; size?: 'md' | 'lg'; block?: boolean }
export declare function Button(props: ButtonProps): React.ReactElement;
export type Status = 'live' | 'voting' | 'succeeded' | 'completed' | 'verified' | 'pending' | 'imported' | 'needs-review' | 'frozen' | 'failed' | 'rejected';
export interface StatusChipProps { status: Status; children?: React.ReactNode }
export declare function StatusChip(props: StatusChipProps): React.ReactElement;
export interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> { label: string; hint?: string; error?: string; suffix?: string; mono?: boolean }
export declare function Field(props: FieldProps): React.ReactElement;
export interface ProgressProps { raised: number; target: number; threshold?: number; currency?: 'EUR' | 'USDC'; meta?: string }
export declare function Progress(props: ProgressProps): React.ReactElement;
export interface CampaignCardProps { title: string; org: string; verified?: boolean; image?: string; imageAlt?: string; currency?: 'EUR' | 'USDC'; status?: Status; raised: number; target: number; donors?: number; daysLeft?: number | null; featured?: boolean }
export declare function CampaignCard(props: CampaignCardProps): React.ReactElement;
export interface LedgerRow { time: string; from: string; label?: string; amount: number; tx: string }
export interface LedgerTableProps { rows: LedgerRow[]; explorerBase?: string; caption?: string }
export declare function LedgerTable(props: LedgerTableProps): React.ReactElement;
export interface AddressProps { value: string; full?: boolean }
export declare function Address(props: AddressProps): React.ReactElement;
export interface TrustScoreProps { score: number; version?: string; imported?: boolean; components: { label: string; value: number }[] }
export declare function TrustScore(props: TrustScoreProps): React.ReactElement;
export interface ProofLinkProps { href?: string; external?: boolean; children?: React.ReactNode }
export declare function ProofLink(props: ProofLinkProps): React.ReactElement;
export interface MilestoneTrackProps { currency?: 'EUR' | 'USDC'; tranches: { label?: string; amount: number; state: 'released' | 'voting' | 'locked' | 'rejected' }[] }
export declare function MilestoneTrack(props: MilestoneTrackProps): React.ReactElement;
export interface VoteMeterProps { turnout: number; approval: number; quorum?: number; pass?: number; closesIn?: string }
export declare function VoteMeter(props: VoteMeterProps): React.ReactElement;
declare global { interface Window { Cherrio: { Button: typeof Button; StatusChip: typeof StatusChip; Field: typeof Field; Progress: typeof Progress; CampaignCard: typeof CampaignCard; LedgerTable: typeof LedgerTable; Address: typeof Address; TrustScore: typeof TrustScore; MilestoneTrack: typeof MilestoneTrack; VoteMeter: typeof VoteMeter; ProofLink: typeof ProofLink; format: { eur(n: number): string; usdc(n: number): string; address(a: string): string } } } }
