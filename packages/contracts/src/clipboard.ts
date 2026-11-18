import { z } from 'zod';

export const ClipboardTextSchema = z.string();

export type ClipboardText = z.infer<typeof ClipboardTextSchema>;
