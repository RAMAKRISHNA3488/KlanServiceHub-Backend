import { z } from 'zod';
 
export const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required.'),
  key: z.string().trim().max(10).optional(),
  category: z.string().optional(),
  image: z.union([z.instanceof(File), z.string().transform((value) => (value === '' ? undefined : value))]).optional(),
  workspaceId: z.string({
    message: 'Workspace id is required.',
  }),
});
 
export const updateProjectSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required.').optional(),
  key: z.string().trim().max(10).optional(),
  category: z.string().optional(),
  image: z.union([z.instanceof(File), z.string().transform((value) => (value === '' ? undefined : value))]).optional(),
  workspaceId: z.string({
    message: 'Workspace id is required.',
  }).optional(),
});

