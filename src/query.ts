import { freeze } from "@ecosy/core/utilities";

export const queries = freeze({
  auth: {
    getMe: "SELECT * FROM users WHERE"
  },
});