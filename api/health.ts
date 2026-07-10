import { handleHealthRequest } from "../scripts/newsApi.js";

export default {
  fetch(request: Request) {
    return handleHealthRequest(request);
  },
};
