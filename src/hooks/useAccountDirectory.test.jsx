import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import useAccountDirectory from './useAccountDirectory'
const api=vi.hoisted(()=>({listUsersPage:vi.fn()}))
vi.mock('../utils/api',()=>api)
const token=async()=> 'token'
beforeEach(()=>vi.resetAllMocks())
it('shows the first page and keeps automatic search explicitly incomplete until all pages finish',async()=>{
    let complete
    api.listUsersPage.mockResolvedValueOnce({users:[{sub:'a',email:'a@example.test'}],nextCursor:'next'})
        .mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve}))
    const {result}=renderHook(()=>useAccountDirectory(token))
    await waitFor(()=>expect(result.current.users).toHaveLength(1))
    expect(result.current.loading).toBe(true)
    await act(async()=>complete({users:[{sub:'b',email:'b@example.test'}],nextCursor:null}))
    expect(result.current.users).toHaveLength(2)
    expect(result.current.loading).toBe(false)
})
it('keeps existing results on a refresh outage and reports repeated cursors',async()=>{
    api.listUsersPage.mockResolvedValue({users:[{sub:'a',email:'a@example.test'}],nextCursor:null})
    const {result}=renderHook(()=>useAccountDirectory(token))
    await waitFor(()=>expect(result.current.loading).toBe(false))
    api.listUsersPage.mockRejectedValueOnce(new Error('outage'))
    await act(async()=>result.current.loadUsers())
    expect(result.current.users).toHaveLength(1)
    expect(result.current.listError).toMatch(/outage.*incomplete/)
    api.listUsersPage.mockResolvedValue({users:[],nextCursor:'repeat'})
    await act(async()=>result.current.loadUsers())
    expect(result.current.listError).toMatch(/repeated page/)
})
it('aborts obsolete work and never accepts late results after unmount',async()=>{
    let finish
    api.listUsersPage.mockImplementation((_token,_params,options)=>new Promise(resolve=>{finish={resolve,signal:options.signal}}))
    const {unmount}=renderHook(()=>useAccountDirectory(token))
    await waitFor(()=>expect(finish).toBeTruthy())
    unmount()
    expect(finish.signal.aborted).toBe(true)
    await act(async()=>finish.resolve({users:[],nextCursor:'next'}))
    expect(api.listUsersPage).toHaveBeenCalledTimes(1)
})
