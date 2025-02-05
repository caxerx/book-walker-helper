import { computed, reactive } from "vue"
import ky from "ky"
import { parallelMap } from "@/utilities/Parallel"

const domParser = new DOMParser()

export interface Book {
  id: number
  name: string
  series: string | null
  favorite: boolean
  bookmark: boolean
}

const state = reactive({
  books: JSON.parse(localStorage.getItem("books") ?? "[]") as Book[],
  topSeries: JSON.parse(localStorage.getItem("topSeries") ?? "[]") as string[],
  loading: false,
  loadingMessage: null as { msg: string; error?: boolean } | null,
})

export const booksProperty = computed(() => state.books)
export const topSeries = computed(() => state.topSeries)
export const loading = computed(() => state.loading)
export const loadingMessage = computed(() => state.loadingMessage)

function saveBooks() {
  localStorage.setItem("books", JSON.stringify(state.books))
}

export async function reloadCollection() {
  state.loading = true
  const originBooks = state.books
  state.books = []

  const { doc, books, error } = await loadAvailableBookList(1)
  if (error === "NO_LOGIN") {
    state.loadingMessage = {
      msg: "解析藏書失敗！請檢查是否已登入 Book Walker 網站。",
      error: true,
    }
    return
  } else if (error === "PARSING_ERROR") {
    state.loadingMessage = {
      msg:
        "解析藏書失敗！請檢查 Book Walker 網站是否正常，或其版面改版需要更新助手。",
      error: true,
    }
    return
  }

  const pageCount = parsePageCount(doc!)
  function recordBookList(books: Book[]) {
    books
      .map(book => {
        const oldBook = originBooks.find(old => old.id === book.id)
        return <Book>{
          id: book.id,
          name: book.name,
          series: oldBook?.series ?? null,
          favorite: oldBook?.favorite ?? false,
          bookmark: oldBook?.bookmark ?? false,
        }
      })
      .forEach(book => state.books.push(book))
    saveBooks()
  }
  recordBookList(books!)

  state.loadingMessage = {
    msg: `藏書資料載入中 1 / ${pageCount}`,
  }

  const pagesNeedLoad = Array.from({ length: pageCount - 1 }, (_, i) => i + 2)
  const loadPageResults = await parallelMap(
    pagesNeedLoad,
    async page => {
      const { books, error } = await loadAvailableBookList(page)
      if (!!error) return error
      recordBookList(books!)
      return null
    },
    5,
    done => {
      state.loadingMessage = {
        msg: `藏書資料載入中 ${done + 1} / ${pageCount}`,
      }
    }
  )

  if (loadPageResults.some(error => error !== null)) {
    state.loadingMessage = {
      msg: `解析藏書有部分失敗！請重試。`,
      error: true,
    }
    return
  }

  const bookNeedLoadSeries = state.books.filter(book => book.series === null)
  const bookNeedLoadSeriesCount = bookNeedLoadSeries.length

  await parallelMap(
    bookNeedLoadSeries,
    async book => {
      book.series = await loadSeries(book.id)
      saveBooks()
    },
    5,
    done => {
      state.loadingMessage = {
        msg: `系列資料載入中 ${done} / ${bookNeedLoadSeriesCount}`,
      }
    }
  )
  state.loading = false
  state.loadingMessage = null
}

async function loadAvailableBookList(
  page: number
): Promise<{
  doc?: Document
  books?: Book[]
  error?: "NO_LOGIN" | "PARSING_ERROR"
}> {
  const response = await ky.get(
    `https://www.bookwalker.com.tw/member/available_book_list?page=${page}`
  )
  if (response.redirected)
    return {
      error: "NO_LOGIN",
    }
  const html = await response.text()
  try {
    const doc = domParser.parseFromString(html, "text/html")
    const books = Array.from(
      doc.getElementById("order_book")!.getElementsByClassName("buy_info")
    ).map(row => {
      const name = row.getElementsByClassName("buy_book")[0].innerHTML
      const id = parseInt(
        (row.getElementsByClassName("bookbor")[0] as HTMLImageElement).src
          .substring("https://image.bookwalker.com.tw/upload/product/".length)
          .split("/")[0]
      )
      return <Book>{
        name,
        id,
        series: null,
      }
    })
    return {
      doc,
      books,
    }
  } catch (error) {
    console.error("解析藏書錯誤", error)
    return {
      error: "PARSING_ERROR",
    }
  }
}

function parsePageCount(doc: Document) {
  return parseInt(
    doc.getElementsByClassName("bw_pagination")[0].lastElementChild!
      .previousElementSibling!.firstElementChild!.innerHTML
  )
}

async function loadSeries(id: number) {
  const html = await ky
    .get(`https://www.bookwalker.com.tw/product/${id}`)
    .text()
  const doc = domParser.parseFromString(html, "text/html")
  try {
    const element = doc.getElementById("breadcrumb_list")!.firstElementChild!
      .lastElementChild!.previousElementSibling!
      .firstElementChild! as HTMLAnchorElement

    return element.href.includes("/search/?series=")
      ? element.innerHTML.substring(0, element.innerHTML.length - 2).trim()
      : ""
  } catch (error) {
    console.error("解析系列錯誤", doc, doc.getElementById("breadcrumb_list"))
    throw error
  }
}

export function switchFavorite(bookId: number) {
  const found = state.books.find(book => book.id == bookId)
  if (!found) return
  found.favorite = !found.favorite
  saveBooks()
}

export function switchBookmark(bookId: number) {
  const found = state.books.find(book => book.id == bookId)
  if (!found) return
  found.bookmark = !found.bookmark
  saveBooks()
}

export function switchTopSeries(name: string) {
  if (state.topSeries.includes(name))
    state.topSeries = state.topSeries.filter(s => s != name)
  else state.topSeries.push(name)
  localStorage.setItem("topSeries", JSON.stringify(state.topSeries))
}
