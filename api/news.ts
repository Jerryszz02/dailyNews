import { handleNewsRequest } from "../scripts/newsApi.js";

export default {
  fetch(request: Request) {
    return handleNewsRequest(request);
  },
};
