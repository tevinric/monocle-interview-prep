import axios from 'axios'

// In production the nginx proxy serves the API from the same origin, so baseURL
// is empty. In local `npm run dev` it points at the backend via VITE_@@PREFIX@@_API_URL.
const api = axios.create({
  baseURL: import.meta.env.PROD
    ? ''
    : (import.meta.env.VITE_@@PREFIX@@_API_URL || 'http://localhost:5100'),
})

export const healthCheck = () => api.get('/api/health')

// Example resource. Replace with your own domain calls.
export const getItems = (params = {}) => api.get('/api/items', { params })
export const getItem = (id) => api.get(`/api/items/${id}`)
export const createItem = (data) => api.post('/api/items', data)
export const updateItem = (id, data) => api.put(`/api/items/${id}`, data)
export const deleteItem = (id) => api.delete(`/api/items/${id}`)

export default api
