import { z } from "zod";
import { orderStatusSchema } from "../orders";
 
const feeSchema = z.object({
  withinHours: z
    .number().int().min(1)
    .describe("The fee applies when the change is requested less than this many hours before the planned delivery date"),
  amountEur: z.number().min(0).describe("Fee amount in euros"),
});
 
/** What the LLM fills in. orgId and version are added by our code, never by the model. */
export const extractedPolicySchema = z.object({
  authorizedStatuses: z
    .array(orderStatusSchema)
    .describe("Order statuses in which the delivery date can still be changed. Statuses not listed are refused."),
  advanceNoticePeriodInHours: z
    .number().int().min(0)
    .describe("Minimum number of hours before the planned delivery date for a change request to be accepted. 0 if the documents set no minimum."),
  rescheduleLimitInDaysFromOriginalOrderDate: z
    .number().int().min(1).nullable()
    .describe("The new date must be at most this many days after the original order date. null if the documents don't say."),
  maxReschedules: z
    .number().int().min(1).nullable()
    .describe("Maximum number of times an order can be rescheduled. null if the documents don't say."),
  fees: z
    .array(feeSchema)
    .describe("Fees for late changes. Empty array if changing the date is free."),
  openDays: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .refine((days) => new Set(days).size === days.length, { message: "openDays must not contain duplicates" })
    .describe("Days on which a new delivery/shipping date is allowed: 1 = Monday ... 7 = Sunday"),
  sources: z
    .array(z.object({ field: z.string(), file: z.string(), quote: z.string() }))
    .describe("For each rule found, the exact quote from the document that justifies it. Used by the human reviewer."),
});
 
export const policySchema = extractedPolicySchema.omit({ sources: true }).extend({
  orgId: z.string(),
  version: z.number().int().min(1),
});
 
export type ExtractedPolicy = z.infer<typeof extractedPolicySchema>;
export type Policy = z.infer<typeof policySchema>;
 