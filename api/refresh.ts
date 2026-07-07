import { handleRefreshRequest } from "../scripts/newsApi.js";

export default {
  fetch(request: Request) {
    return handleRefreshRequest(request);
  },
};
