import { handleCronRequest } from "../scripts/newsApi.js";

export default {
  fetch(request: Request) {
    return handleCronRequest(request);
  },
};
