import { z } from 'zod';

export const IdSchema = z.uuid();

export type Id = z.infer<typeof IdSchema>;
